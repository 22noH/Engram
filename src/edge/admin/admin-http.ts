import * as fs from 'fs';
import * as path from 'path';
import type * as http from 'http';
import type { Account, AccountStore } from '../auth/account-store';
import type { SessionStore } from '../auth/session-store';
import type { GroupStore } from '../auth/group-store';
import type { ChatStore } from '../messenger/chat-store';
import type { WikiEngine } from '../../knowledge-core/wiki/wiki-engine';
import type { ProposalStore } from '../../knowledge-core/proposal-store';
import { resolveResourceDir } from '../../pal/resource-dir';
import { sanitizePermissions } from '../auth/permissions';

// /admin http 창구(서버 콘솔 S1, 플랜 docs/superpowers/plans/2026-07-19-server-console-s1.md Task 2).
// AuthHttp와 같은 결: 파싱/응답만, 로직은 store에 위임. self.adapter가 authDeps+adminDeps 둘 다
// 있을 때만 이리로 위임하므로(brain 모드·미주입=404 폴스루) 여기선 항상 세션 게이트가 유효하다고 가정한다.
// 정적 서빙: console/dist(패키징 경로 해석은 prompts/ 로딩 관성 — resolveResourceDir 재사용).

export interface AdminHttpDeps {
  accounts: AccountStore;
  sessions: SessionStore;
  chat: ChatStore;
  groups: GroupStore;
  wiki: WikiEngine;
  proposals: ProposalStore;
  distDir?: string; // 테스트 주입용. 기본값은 resolveResourceDir('console/dist').
}

// 본문 크기 상한(멤버/그룹/채널 api는 전부 소형 JSON — 폭주 방어용 저비용 캡).
const MAX_BODY_BYTES = 64 * 1024;

// 컨트롤러 계약 확장(처리할 일 목록에 이름/제목 표시): 최초 5개까지만(개요 타일용 — 저비용 상한).
const TODO_PREVIEW_CAP = 5;

export interface OverviewDto {
  members: number;
  pendingMembers: number;
  channels: number;
  wikiPages: number;
  pendingProposals: number;
  todayMessages: number;
  pendingMemberNames: string[];
  pendingProposalTitles: string[];
}

// 콘텐츠 타입 화이트리스트(정적 서빙 보안 — 목록 밖 확장자는 존재해도 404).
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function bearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

export class AdminHttp {
  private readonly root: string;

  constructor(private readonly deps: AdminHttpDeps) {
    this.root = path.resolve(deps.distDir ?? resolveResourceDir('console/dist'));
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  private notFound(res: http.ServerResponse): void {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const raw = (req.url ?? '').split('?')[0];
    if (raw !== '/admin' && !raw.startsWith('/admin/')) return false;

    // Minor 1(리뷰 지적): 예전엔 api 접두 매칭은 raw(미디코딩) url로, 정적 서빙은 내부에서 따로
    // decode해 둘이 다른 값을 보고 있었다 — 그래서 /admin/%61pi/overview(encoded 'a') 같은 요청이
    // api 게이트(401/403)를 우회해 정적 서빙으로 새버렸다. 여기서 한 번만 decode해 이후 라우팅
    // (api 접두 매칭 + 정적 경로 해석) 전부 그 decoded 값 하나로 통일한다. 깨진 인코딩은 404.
    let url: string;
    try { url = decodeURIComponent(raw); } catch { this.notFound(res); return true; }

    // Important(리뷰 지적): console 자산이 base='/admin/'(상대 경로가 아닌 고정 마운트)이라
    // GET /admin(트레일링 슬래시 없이)로 index.html을 서빙하면 자산 URL이 사이트 루트 기준으로
    // 풀려 404→빈 페이지가 됐다. 무슬래시 정확 매치는 쿼리스트링 보존한 채 /admin/로 302.
    if (url === '/admin') {
      const qIdx = (req.url ?? '').indexOf('?');
      const query = qIdx >= 0 ? (req.url ?? '').slice(qIdx) : '';
      res.writeHead(302, { location: '/admin/' + query });
      res.end();
      return true;
    }

    if (url.startsWith('/admin/api/')) {
      await this.routeApi(url, req, res);
      return true;
    }

    if (req.method !== 'GET') { this.notFound(res); return true; }
    this.serveStatic(url, res);
    return true;
  }

  // /admin/api/ 라우팅(decoded url — Minor 1 관성, handle()에서 이미 1회 decode됨).
  // 멤버·그룹·채널 api는 전부 owner 게이트(requireOwner)가 응답까지 처리하므로 각 핸들러는
  // acc가 null이면 즉시 return(이미 401/403 응답 완료). 경로 매칭 실패는 전부 404(메서드 불일치 포함
  // — overview의 기존 관성과 동일 톤, REST 규약 "메서드 불일치 404/405 일관"의 404 쪽 선택).
  private async routeApi(url: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    try {
      if (url === '/admin/api/overview' && method === 'GET') { await this.overview(req, res); return; }

      if (url === '/admin/api/members' && method === 'GET') { await this.listMembers(req, res); return; }
      if (url === '/admin/api/members' && method === 'POST') { await this.createMember(req, res); return; }
      let m = /^\/admin\/api\/members\/([^/]+)\/status$/.exec(url);
      if (m && method === 'POST') { await this.setMemberStatus(req, res, m[1]); return; }
      m = /^\/admin\/api\/members\/([^/]+)\/permissions$/.exec(url);
      if (m && method === 'POST') { await this.setMemberPermissions(req, res, m[1]); return; }

      if (url === '/admin/api/groups' && method === 'GET') { await this.listGroups(req, res); return; }
      if (url === '/admin/api/groups' && method === 'POST') { await this.createGroup(req, res); return; }
      m = /^\/admin\/api\/groups\/([^/]+)$/.exec(url);
      if (m && method === 'PATCH') { await this.patchGroup(req, res, m[1]); return; }
      if (m && method === 'DELETE') { await this.deleteGroup(req, res, m[1]); return; }

      if (url === '/admin/api/channels' && method === 'GET') { await this.listChannelsApi(req, res); return; }
      m = /^\/admin\/api\/channels\/([^/]+)\/visibility$/.exec(url);
      if (m && method === 'POST') { await this.setChannelVisibility(req, res, m[1]); return; }
      m = /^\/admin\/api\/channels\/([^/]+)$/.exec(url);
      if (m && method === 'DELETE') { await this.deleteChannelApi(req, res, m[1]); return; }

      this.notFound(res); // S1/S2 범위 밖 api 경로 + 메서드 불일치
    } catch {
      this.json(res, 500, { error: 'internal' });
    }
  }

  // owner 세션 필수(스펙: Authorization: Bearer <token> → sessions.resolve → role==='owner'
  // 아니면 403; 계정 0(미설정 서버)은 토큰 검사보다 먼저 401 — 셋업 전에 데이터 노출 금지).
  // 실패 시 401/403 응답을 직접 쓰고 null을 반환한다 — 호출부는 null이면 즉시 return.
  private requireOwner(req: http.IncomingMessage, res: http.ServerResponse): Account | null {
    const { accounts, sessions } = this.deps;
    if (accounts.count() === 0) { this.json(res, 401, { error: 'unconfigured' }); return null; }
    const token = bearer(req);
    const sess = token ? sessions.resolve(token) : null;
    const acc = sess ? accounts.get(sess.userId) : null;
    if (!acc) { this.json(res, 401, { error: 'unauthorized' }); return null; }
    if (acc.role !== 'owner') { this.json(res, 403, { error: 'forbidden' }); return null; }
    return acc;
  }

  // POST/PATCH 본문 읽기: 크기 상한 초과·JSON 파싱 실패는 전부 ok:false(호출부는 400으로 응답).
  // 본문 없음(빈 스트림)은 빈 객체로 취급(필드 전부 옵션인 엔드포인트 없음 — 이후 필드별 검증이 걸러낸다).
  // 과대 본문 시 소켓 파괴 금지(req.destroy() 하면 응답 왕복 불가 → 클라가 ECONNRESET 받음).
  // 대신 accumulate 중단 후 정착 유보하고 호출부가 400 응답 쓸 수 있도록 유지(auth-http.ts 관례).
  private readBody(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false }> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (v: { ok: true; body: unknown } | { ok: false }) => { if (!settled) { settled = true; resolve(v); } };
      let data = '';
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        if (tooBig) return; // 이미 정착 — 소켓은 파괴하지 않고 흘려보내기만(응답 왕복 유지)
        data += chunk.toString('utf8');
        if (data.length > MAX_BODY_BYTES) { tooBig = true; settle({ ok: false }); } // 과대 본문: destroy() 없이 즉시 정착
      });
      req.on('end', () => {
        if (tooBig) return; // 이미 위에서 정착
        if (!data.trim()) { settle({ ok: true, body: {} }); return; }
        try { settle({ ok: true, body: JSON.parse(data) }); }
        catch { settle({ ok: false }); }
      });
      req.on('error', () => settle({ ok: false }));
      req.on('close', () => settle({ ok: false })); // destroy()/중단 시 'end'가 안 옴 — 정착 보장
      req.on('aborted', () => settle({ ok: false }));
    });
  }

  private async overview(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const acc = this.requireOwner(req, res);
      if (!acc) return;
      const { accounts } = this.deps;

      const all = accounts.list();
      const pendingAccounts = all.filter((a) => a.status === 'pending');
      const members = all.filter((a) => a.status === 'active').length;
      const pendingMembers = pendingAccounts.length;
      const pendingMemberNames = pendingAccounts.slice(0, TODO_PREVIEW_CAP).map((a) => a.displayName || a.loginId);
      const channels = this.deps.chat.listChannels().length;
      const wikiPages = (await this.deps.wiki.listPages()).length;
      const pendingProposalsList = await this.deps.proposals.listPending();
      const pendingProposals = pendingProposalsList.length;
      const pendingProposalTitles = pendingProposalsList.slice(0, TODO_PREVIEW_CAP).map((p) => p.title);
      const todayMessages = this.countTodayMessages();

      const body: OverviewDto = {
        members, pendingMembers, channels, wikiPages, pendingProposals, todayMessages,
        pendingMemberNames, pendingProposalTitles,
      };
      this.json(res, 200, body);
    } catch {
      this.json(res, 500, { error: 'internal' });
    }
  }

  // 오늘자(서버 로컬 자정 기준) 전 채널 메시지 수. chat-store에 날짜 인덱스가 없어(jsonl append-only)
  // 채널별 전체 읽기(history()의 기존 O(n) 관성, ponytail 주석 참조)로 셀 수밖에 없다 — 개인/소규모
  // 서버 스케일에서는 허용 범위(기존 history() 호출 비용과 동급). 채널 수가 커지면 재검토 대상.
  private countTodayMessages(): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const cutoff = start.getTime();
    let count = 0;
    for (const ch of this.deps.chat.listChannels()) {
      const msgs = this.deps.chat.history(ch.id, { limit: Number.MAX_SAFE_INTEGER });
      for (const m of msgs) {
        if (new Date(m.ts).getTime() >= cutoff) count++;
      }
    }
    return count;
  }

  // console/dist 정적 서빙. url은 handle()에서 이미 1회 decode됐다(Minor 1 — 여기서 다시 decode하지
  // 않는다, 이중 디코딩은 별개 취약점). traversal 차단: rawRel은 항상 '/'로 시작(또는 특수케이스
  // '/admin' 자체)하므로 path.normalize가 절대경로 취급해 '..'를 루트 밖으로 못 나가게 collapse한다
  // (Node 관성) — 그 뒤 선행 구분자를 벗겨 "루트 기준 상대경로"로만 join하므로 root 밖 이스케이프가
  // 원천 불가. 단 path.normalize는 선행 '//'(UNC 표식)는 collapse 없이 보존하는 케이스가 있어, 뒤이은
  // 정규식이 그 UNC 표식까지 몽땅 벗겨내면 '..'가 안 지워진 채 남을 수 있다 — 그 경우도 아래
  // filePath.startsWith(withSep) 방어선이 잡아낸다(정규화 방식과 무관하게 최종 결과 위치로 판정).
  private serveStatic(url: string, res: http.ServerResponse): void {
    const rel = url === '/admin' ? '/index.html' : url.slice('/admin'.length);
    const normalized = path.normalize(rel).replace(/^[/\\]+/, '');
    const filePath = path.resolve(this.root, normalized || 'index.html');
    const withSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (filePath !== this.root && !filePath.startsWith(withSep)) { this.notFound(res); return; }

    let target = filePath;
    let isFile = false;
    try { isFile = fs.statSync(target).isFile(); } catch { isFile = false; }
    if (!isFile) {
      if (path.extname(target)) { this.notFound(res); return; } // 확장자 있는 자산 없음 = 진짜 404
      target = path.join(this.root, 'index.html'); // SPA 폴백(확장자 없는 미지 라우트)
      try { isFile = fs.statSync(target).isFile(); } catch { isFile = false; }
      if (!isFile) { this.notFound(res); return; }
    }
    const type = CONTENT_TYPES[path.extname(target)];
    if (!type) { this.notFound(res); return; } // 화이트리스트 밖 확장자
    try {
      const data = fs.readFileSync(target);
      res.writeHead(200, { 'content-type': type });
      res.end(data);
    } catch {
      this.notFound(res);
    }
  }

  // ── 멤버 api(서버 콘솔 S2 Task 2) ──────────────────────────────────────

  private async listMembers(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const { accounts, groups } = this.deps;
    const members = accounts.list().map((a) => ({
      id: a.id,
      loginId: a.loginId,
      displayName: a.displayName,
      role: a.role,
      status: a.status,
      permissions: a.permissions ?? [],
      groups: groups.groupsOf(a.id).map((g) => g.name), // 그룹명(브리프 계약 — id 아님)
    }));
    this.json(res, 200, { members });
  }

  private async createMember(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const parsed = await this.readBody(req);
    if (!parsed.ok) { this.json(res, 400, { error: 'bad_body' }); return; }
    const body = parsed.body as Record<string, unknown>;
    const loginId = typeof body.loginId === 'string' ? body.loginId : '';
    const displayName = typeof body.displayName === 'string' ? body.displayName : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const groupId = typeof body.groupId === 'string' ? body.groupId : undefined;
    if (!loginId.trim() || !displayName.trim() || !password) { this.json(res, 400, { error: 'invalid_body' }); return; }

    const { accounts, groups } = this.deps;
    if (accounts.getByLoginId(loginId)) { this.json(res, 409, { error: 'duplicate_login_id' }); return; }

    let created;
    try {
      // 관리자 직접 생성 = 즉시 활성(가입 승인 대기 흐름과 구분 — 브리프 계약).
      created = accounts.createPassword(loginId, password, displayName, { role: 'member', status: 'active' });
    } catch {
      this.json(res, 400, { error: 'invalid_body' }); return;
    }

    let groupNames: string[] = [];
    if (groupId) {
      const g = groups.get(groupId);
      if (g) {
        groups.setMembers(g.id, [...g.memberIds, created.id]);
        groupNames = [g.name];
      } // 존재하지 않는 groupId는 조용히 무시 — 계정 생성 성공이 우선(브리프에 실패 규약 없음).
    }
    this.json(res, 200, {
      member: {
        id: created.id, loginId: created.loginId, displayName: created.displayName,
        role: created.role, status: created.status, permissions: created.permissions ?? [],
        groups: groupNames,
      },
    });
  }

  private async setMemberStatus(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const target = this.deps.accounts.get(id);
    if (!target) { this.json(res, 404, { error: 'not_found' }); return; }
    const parsed = await this.readBody(req);
    if (!parsed.ok) { this.json(res, 400, { error: 'bad_body' }); return; }
    const body = parsed.body as Record<string, unknown>;
    const status = body.status;
    if (status !== 'pending' && status !== 'active' && status !== 'suspended') {
      this.json(res, 400, { error: 'invalid_status' }); return;
    }
    // 가드(브리프): owner는 자기 자신을 정지/강등할 수 없다 — 관리자가 자기 계정으로 스스로를
    // 잠그는 사고를 원천 차단(이 api엔 역할 변경 엔드포인트가 없어 상태만 판정하면 충분).
    if (target.id === acc.id && status !== 'active') {
      this.json(res, 403, { error: 'cannot_change_self' }); return;
    }
    this.deps.accounts.setStatus(id, status);
    this.json(res, 200, { ok: true });
  }

  private async setMemberPermissions(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const target = this.deps.accounts.get(id);
    if (!target) { this.json(res, 404, { error: 'not_found' }); return; }
    const parsed = await this.readBody(req);
    if (!parsed.ok) { this.json(res, 400, { error: 'bad_body' }); return; }
    const body = parsed.body as Record<string, unknown>;
    const perms = sanitizePermissions(body.permissions); // 허용 5키 밖은 소독(house rule)
    this.deps.accounts.setPermissions(id, perms);
    this.json(res, 200, { ok: true });
  }

  // ── 그룹 api ────────────────────────────────────────────────────────

  private async listGroups(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    this.json(res, 200, { groups: this.deps.groups.list() });
  }

  private async createGroup(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const parsed = await this.readBody(req);
    if (!parsed.ok) { this.json(res, 400, { error: 'bad_body' }); return; }
    const body = parsed.body as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name : '';
    if (!name.trim()) { this.json(res, 400, { error: 'invalid_body' }); return; }
    let g;
    try { g = this.deps.groups.create(name); }
    catch { this.json(res, 400, { error: 'invalid_name' }); return; }
    this.json(res, 200, { group: g });
  }

  private async patchGroup(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const { groups, accounts, chat } = this.deps;
    if (!groups.get(id)) { this.json(res, 404, { error: 'not_found' }); return; }
    const parsed = await this.readBody(req);
    if (!parsed.ok) { this.json(res, 400, { error: 'bad_body' }); return; }
    const body = parsed.body as Record<string, unknown>;

    // 넘긴 필드만 갱신(브리프: 부분 PATCH). 각 필드는 store가 소독/중복제거하지만, memberIds·
    // channelIds는 그 위에 "실존하는 계정/채널만" 한 번 더 걸러(group-store.ts 주석의 계약 —
    // 계정 id 검증은 호출자 몫) 존재하지 않는 id가 그룹에 조용히 눌러앉는 걸 막는다.
    if (typeof body.name === 'string') {
      try { groups.rename(id, body.name); }
      catch { this.json(res, 400, { error: 'invalid_name' }); return; }
    }
    if (Array.isArray(body.memberIds)) {
      const validIds = new Set(accounts.list().map((a) => a.id));
      const ids = body.memberIds.filter((x): x is string => typeof x === 'string' && validIds.has(x));
      groups.setMembers(id, ids);
    }
    if (Array.isArray(body.permissions)) {
      groups.setPermissions(id, body.permissions.filter((x): x is string => typeof x === 'string'));
    }
    if (Array.isArray(body.channelIds)) {
      const validChannelIds = new Set(chat.listChannels().map((c) => c.id));
      const ids = body.channelIds.filter((x): x is string => typeof x === 'string' && validChannelIds.has(x));
      groups.setChannels(id, ids);
    }
    this.json(res, 200, { group: groups.get(id) });
  }

  private async deleteGroup(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    if (!this.deps.groups.remove(id)) { this.json(res, 404, { error: 'not_found' }); return; }
    this.json(res, 200, { ok: true });
  }

  // ── 채널 api(메타만 — 대화 내용은 절대 이 응답에 실리지 않는다) ──────────────

  private async listChannelsApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const channels = this.deps.chat.listChannels().map((c) => ({
      id: c.id,
      name: c.name,
      mode: c.mode ?? 'chat',
      visibility: c.visibility ?? 'public',
      memberCount: c.memberIds?.length ?? 0,
      ...(c.brain ? { brain: c.brain } : {}),
    }));
    this.json(res, 200, { channels });
  }

  private async setChannelVisibility(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    if (!this.deps.chat.has(id)) { this.json(res, 404, { error: 'not_found' }); return; }
    const parsed = await this.readBody(req);
    if (!parsed.ok) { this.json(res, 400, { error: 'bad_body' }); return; }
    const body = parsed.body as Record<string, unknown>;
    if (body.visibility !== 'public' && body.visibility !== 'private') {
      this.json(res, 400, { error: 'invalid_visibility' }); return;
    }
    this.deps.chat.setVisibility(id, body.visibility);
    this.json(res, 200, { ok: true });
  }

  private async deleteChannelApi(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    if (!this.deps.chat.deleteChannel(id)) { this.json(res, 404, { error: 'not_found' }); return; }
    this.json(res, 200, { ok: true });
  }
}
