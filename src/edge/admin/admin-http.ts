import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type * as http from 'http';
import type { Account, AccountStore } from '../auth/account-store';
import type { SessionStore } from '../auth/session-store';
import type { GroupStore } from '../auth/group-store';
import type { ChatStore } from '../messenger/chat-store';
import type { WikiEngine } from '../../knowledge-core/wiki/wiki-engine';
import type { ProposalStore } from '../../knowledge-core/proposal-store';
import { resolveResourceDir } from '../../pal/resource-dir';
import { sanitizePermissions } from '../auth/permissions';
import { listBrainDetails, setDefaultBrain, removeBrainProfile } from '../../desktop/brains-file';
import { addOllamaProfile } from '../../desktop/ollama';
import { saveAnthropicApiKey } from '../../desktop/api-brain';
import { listMcpServersFile, addMcpServer, removeMcpServer } from '../../desktop/mcp-file';
import { readWikiRemoteFile, saveWikiRemote } from '../../desktop/wiki-remote-file';
import { loadAuthSettings, saveAuthSettings, type AuthSettings } from '../auth/auth.config';
import { loadChatConfig, saveChatBootConfig } from '../messenger/chat.config';
import { getCommandMode, setCommandMode, type CommandMode } from '../../desktop/permissions-file';
import { buildPreset } from '../../desktop/preset-file';

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
  configDir: string; // 모델·MCP api(서버 콘솔 S3 Task 1)용 — brains.json/mcp.json 위치.
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

// 임시 비밀번호(비번 리셋 응답으로 owner에게 반환 — 목업 "임시 비밀번호" 필드 관성).
// base64url(7바이트) = 10자 고정폭(패딩 없음) — 사용자가 그대로 옮겨 적기 쉬운 길이.
function generateTempPassword(): string {
  return randomBytes(7).toString('base64url');
}

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
      m = /^\/admin\/api\/members\/([^/]+)\/reset-password$/.exec(url);
      if (m && method === 'POST') { await this.resetMemberPassword(req, res, m[1]); return; }
      m = /^\/admin\/api\/members\/([^/]+)$/.exec(url);
      if (m && method === 'DELETE') { await this.deleteMember(req, res, m[1]); return; }

      if (url === '/admin/api/groups' && method === 'GET') { await this.listGroups(req, res); return; }
      if (url === '/admin/api/groups' && method === 'POST') { await this.createGroup(req, res); return; }
      m = /^\/admin\/api\/groups\/([^/]+)$/.exec(url);
      if (m && method === 'PATCH') { await this.patchGroup(req, res, m[1]); return; }
      if (m && method === 'DELETE') { await this.deleteGroup(req, res, m[1]); return; }

      if (url === '/admin/api/channels' && method === 'GET') { await this.listChannelsApi(req, res); return; }
      m = /^\/admin\/api\/channels\/([^/]+)\/visibility$/.exec(url);
      if (m && method === 'POST') { await this.setChannelVisibility(req, res, m[1]); return; }
      m = /^\/admin\/api\/channels\/([^/]+)\/members$/.exec(url);
      if (m && method === 'POST') { await this.setChannelMembers(req, res, m[1]); return; }
      m = /^\/admin\/api\/channels\/([^/]+)\/groups$/.exec(url);
      if (m && method === 'POST') { await this.setChannelGroups(req, res, m[1]); return; }
      m = /^\/admin\/api\/channels\/([^/]+)$/.exec(url);
      if (m && method === 'GET') { await this.getChannelDetail(req, res, m[1]); return; }
      if (m && method === 'DELETE') { await this.deleteChannelApi(req, res, m[1]); return; }

      if (url === '/admin/api/models' && method === 'GET') { await this.listModels(req, res); return; }
      if (url === '/admin/api/models/ollama' && method === 'POST') { await this.addOllamaModel(req, res); return; }
      if (url === '/admin/api/models/api-key' && method === 'POST') { await this.saveModelApiKey(req, res); return; }
      if (url === '/admin/api/models/default' && method === 'POST') { await this.setDefaultModel(req, res); return; }
      m = /^\/admin\/api\/models\/([^/]+)$/.exec(url);
      if (m && method === 'DELETE') { await this.deleteModel(req, res, m[1]); return; }

      if (url === '/admin/api/mcp' && method === 'GET') { await this.listMcp(req, res); return; }
      if (url === '/admin/api/mcp' && method === 'POST') { await this.addMcp(req, res); return; }
      m = /^\/admin\/api\/mcp\/([^/]+)$/.exec(url);
      if (m && method === 'DELETE') { await this.deleteMcp(req, res, m[1]); return; }

      if (url === '/admin/api/wiki' && method === 'GET') { await this.getWiki(req, res); return; }
      if (url === '/admin/api/wiki/remote' && method === 'POST') { await this.saveWikiRemoteApi(req, res); return; }

      if (url === '/admin/api/server-settings' && method === 'GET') { await this.getServerSettings(req, res); return; }
      if (url === '/admin/api/server-settings' && method === 'POST') { await this.saveServerSettings(req, res); return; }

      if (url === '/admin/api/preset' && method === 'GET') { await this.getPreset(req, res); return; }

      this.notFound(res); // S1/S2/S3 범위 밖 api 경로 + 메서드 불일치
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

  // 비번 리셋(서버 콘솔 S2 Task 3b): 서버가 새 임시 비번을 생성해 setPassword로 반영하고,
  // owner가 본인에게 전달할 수 있도록 응답 본문에 실어 돌려준다. 자기 자신 리셋도 허용
  // (owner가 자기 로그인 pw를 재발급받는 정상 시나리오 — 상태 변경 자기가드와 다른 결).
  private async resetMemberPassword(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    if (!this.deps.accounts.get(id)) { this.json(res, 404, { error: 'not_found' }); return; }
    const tempPassword = generateTempPassword();
    this.deps.accounts.setPassword(id, tempPassword);
    this.json(res, 200, { tempPassword });
  }

  // 거절/삭제(서버 콘솔 S2 Task 3b). owner는 자기 자신도, 다른 owner 계정도 지울 수 없다
  // (서버가 owner 없는 상태로 잠기는 사고 방지 — setMemberStatus 자기가드와 같은 결).
  // 성공 시 그룹 memberIds·비공개 채널 memberIds에서도 이 계정을 빼(dangling 참조 방지) 세션도 전부 무효화한다.
  private async deleteMember(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const target = this.deps.accounts.get(id);
    if (!target) { this.json(res, 404, { error: 'not_found' }); return; }
    if (target.id === acc.id || target.role === 'owner') {
      this.json(res, 403, { error: 'cannot_delete_owner' }); return;
    }
    const { groups, sessions, chat } = this.deps;
    for (const g of groups.list()) {
      if (g.memberIds.includes(id)) {
        groups.setMembers(g.id, g.memberIds.filter((x) => x !== id));
      }
    }
    // 채널 memberIds에서도 제거 — 유령 참조/memberCount 오염 방지(리뷰 지적, 자가치유를 즉시화).
    for (const ch of chat.listChannels()) {
      if (Array.isArray(ch.memberIds) && ch.memberIds.includes(id)) {
        chat.setMembers(ch.id, ch.memberIds.filter((x) => x !== id));
      }
    }
    this.deps.accounts.remove(id);
    sessions.revokeAllFor(id); // 삭제된 계정의 세션은 즉시 무효화(session-store.ts 기존 API 재사용)
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

  // 목업 3단계 배지(공개/그룹 한정/비공개) 판정에 필요한 재료: memberCount(비공개+멤버 직접지정용)
  // + groups(그룹명 — 이 채널을 channelIds에 담은 그룹들). 콘솔 쪽 판정 규칙(브리프):
  // public → 공개, private+groups.length>=1 → 그룹 한정, private+groups.length===0 → 비공개.
  private async listChannelsApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const allGroups = this.deps.groups.list();
    const channels = this.deps.chat.listChannels().map((c) => ({
      id: c.id,
      name: c.name,
      mode: c.mode ?? 'chat',
      visibility: c.visibility ?? 'public',
      memberCount: c.memberIds?.length ?? 0,
      groups: allGroups.filter((g) => g.channelIds.includes(c.id)).map((g) => g.name),
      ...(c.brain ? { brain: c.brain } : {}),
    }));
    this.json(res, 200, { channels });
  }

  // 단일 채널 상세(멤버 편집기용 — memberIds가 실리는 유일한 엔드포인트. 대화 내용은 여전히
  // 절대 안 실림, PII 최소화 관성은 목록 API와 동일하되 "누가 이 채널에 들어와 있는지"는
  // owner가 접근을 편집하려면 알아야 하는 정보라 여기서만 예외적으로 노출한다).
  private async getChannelDetail(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const ch = this.deps.chat.listChannels().find((c) => c.id === id);
    if (!ch) { this.json(res, 404, { error: 'not_found' }); return; }
    const groupIds = this.deps.groups.list().filter((g) => g.channelIds.includes(id)).map((g) => g.id);
    this.json(res, 200, {
      id: ch.id,
      name: ch.name,
      visibility: ch.visibility ?? 'public',
      memberIds: ch.memberIds ?? [],
      groupIds,
    });
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

  // 목업 ⑤채널의 "멤버" 버튼(비공개+멤버 직접지정 채널) — 이 채널에 들어올 수 있는 계정 id 집합을
  // 통째로 교체한다(PATCH groups의 memberIds 관성과 동일: 넘어온 배열이 곧 최종 상태).
  // 실존하지 않는 계정 id는 조용히 걸러낸다(patchGroup의 validIds 필터와 같은 결).
  private async setChannelMembers(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const { chat, accounts } = this.deps;
    if (!chat.has(id)) { this.json(res, 404, { error: 'not_found' }); return; }
    const parsed = await this.readBody(req);
    if (!parsed.ok) { this.json(res, 400, { error: 'bad_body' }); return; }
    const body = parsed.body as Record<string, unknown>;
    if (!Array.isArray(body.memberIds)) { this.json(res, 400, { error: 'invalid_body' }); return; }
    const validIds = new Set(accounts.list().map((a) => a.id));
    const ids = body.memberIds.filter((x): x is string => typeof x === 'string' && validIds.has(x));
    chat.setMembers(id, ids);
    this.json(res, 200, { ok: true });
  }

  // 목업 ⑤채널의 "접근" 버튼(그룹 한정 채널) — "이 채널에 접근 가능한 그룹" 집합을 groupIds로
  // 통째로 교체한다. 채널 쪽엔 그룹 참조 필드가 없어(그룹이 channelIds로 채널을 담는 반대 방향
  // 설계 — group-store.ts 관성) 전 그룹을 순회하며 이 채널 id를 채널명단에 넣거나 뺀다.
  private async setChannelGroups(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const { chat, groups } = this.deps;
    if (!chat.has(id)) { this.json(res, 404, { error: 'not_found' }); return; }
    const parsed = await this.readBody(req);
    if (!parsed.ok) { this.json(res, 400, { error: 'bad_body' }); return; }
    const body = parsed.body as Record<string, unknown>;
    if (!Array.isArray(body.groupIds)) { this.json(res, 400, { error: 'invalid_body' }); return; }
    const allGroups = groups.list();
    const validGroupIds = new Set(allGroups.map((g) => g.id));
    const targetSet = new Set(body.groupIds.filter((x): x is string => typeof x === 'string' && validGroupIds.has(x)));
    for (const g of allGroups) {
      const has = g.channelIds.includes(id);
      const want = targetSet.has(g.id);
      if (has === want) continue; // 변경 없음 — 불필요한 저장 왕복 skip
      const nextChannelIds = want ? [...g.channelIds, id] : g.channelIds.filter((c) => c !== id);
      groups.setChannels(g.id, nextChannelIds);
    }
    this.json(res, 200, { ok: true });
  }

  // ── 모델 API(서버 콘솔 S3 Task 1 — brains-file/ollama/api-brain 재사용) ──────────────────
  // ★보안 핵심: listBrainDetails가 이미 apiKey/searchApiKey 원문을 걷어내고 hasApiKey/hasSearchApiKey
  // boolean만 반환한다(브리프의 "데스크톱 설정 UI화 때 Critical이었던 원문 유출" 그 클래스 재발 방지 —
  // 그 헬퍼가 바로 그 사고 이후 만들어진 안전 DTO다). 여기선 그 DTO에서 필요한 필드만 다시 골라
  // 응답에 실으므로, apiKey 필드 자체가 이 함수의 어떤 변수에도 존재하지 않는다.
  private async listModels(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const details = listBrainDetails(this.deps.configDir);
    const defaultEntry = details.find((d) => d.isDefault);
    // 브리프 규약: 기본 두뇌 provider가 anthropic-api/openai-api(엔그램 자체 하네스)면 'engram',
    // 그 외(claude-cli 등 CLI 하네스)·미등록이면 'cli'.
    const harness: 'cli' | 'engram' =
      defaultEntry && (defaultEntry.provider === 'anthropic-api' || defaultEntry.provider === 'openai-api')
        ? 'engram' : 'cli';
    const models = details.map((d) => ({
      key: d.key, provider: d.provider, model: d.model, isDefault: d.isDefault, hasApiKey: d.hasApiKey,
    }));
    this.json(res, 200, { default: defaultEntry?.key ?? '', harness, models });
  }

  private async addOllamaModel(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const parsed = await this.readBody(req);
    if (!parsed.ok) { this.json(res, 400, { error: 'bad_body' }); return; }
    const body = parsed.body as Record<string, unknown>;
    const model = typeof body.model === 'string' ? body.model : '';
    const name = typeof body.name === 'string' ? body.name : '';
    if (!model.trim() || !name.trim()) { this.json(res, 400, { error: 'invalid_body' }); return; }
    const setDefault = body.setDefault === true;
    addOllamaProfile(this.deps.configDir, model, name, setDefault);
    this.json(res, 200, { ok: true });
  }

  // apiKey 값은 요청 본문에서만 읽고 저장 헬퍼로 곧장 넘긴다 — 응답 본문에는 절대 되싣지 않는다.
  private async saveModelApiKey(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const parsed = await this.readBody(req);
    if (!parsed.ok) { this.json(res, 400, { error: 'bad_body' }); return; }
    const body = parsed.body as Record<string, unknown>;
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
    if (!apiKey.trim()) { this.json(res, 400, { error: 'invalid_body' }); return; } // 빈 값=저장할 게 없음
    const setDefault = body.setDefault === true;
    saveAnthropicApiKey(this.deps.configDir, apiKey, setDefault);
    this.json(res, 200, { ok: true });
  }

  private async setDefaultModel(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const parsed = await this.readBody(req);
    if (!parsed.ok) { this.json(res, 400, { error: 'bad_body' }); return; }
    const body = parsed.body as Record<string, unknown>;
    const key = typeof body.key === 'string' ? body.key : '';
    if (!key.trim()) { this.json(res, 400, { error: 'invalid_body' }); return; }
    if (!listBrainDetails(this.deps.configDir).some((d) => d.key === key)) {
      this.json(res, 404, { error: 'not_found' }); return;
    }
    setDefaultBrain(this.deps.configDir, key);
    this.json(res, 200, { ok: true });
  }

  // removeBrainProfile은 key===default면 조용히 no-op(파일 계층의 최종 안전선 — brains-file.ts 주석)
  // 이라 여기서 먼저 판별해 400으로 명시한다(브리프: "먼저 다른 모델을 기본으로").
  private async deleteModel(req: http.IncomingMessage, res: http.ServerResponse, key: string): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const entry = listBrainDetails(this.deps.configDir).find((d) => d.key === key);
    if (!entry) { this.json(res, 404, { error: 'not_found' }); return; }
    if (entry.isDefault) { this.json(res, 400, { error: 'cannot_delete_default' }); return; }
    removeBrainProfile(this.deps.configDir, key);
    this.json(res, 200, { ok: true });
  }

  // ── MCP API(서버 콘솔 S3 Task 1 — mcp-file.ts 재사용) ──────────────────────────────────

  private async listMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    this.json(res, 200, { servers: listMcpServersFile(this.deps.configDir) });
  }

  private async addMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const parsed = await this.readBody(req);
    if (!parsed.ok) { this.json(res, 400, { error: 'bad_body' }); return; }
    const body = parsed.body as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name : '';
    const commandOrUrl = typeof body.commandOrUrl === 'string' ? body.commandOrUrl : '';
    // addMcpServer는 이름 규칙 위반·빈 명령·중복을 전부 false로 뭉뚱그린다 — 브리프가 요구하는
    // 409(중복)를 400(그 외 무효 입력)과 구분하려면 중복만 먼저 따로 판별해야 한다.
    if (listMcpServersFile(this.deps.configDir).some((s) => s.name === name)) {
      this.json(res, 409, { error: 'duplicate' }); return;
    }
    const ok = addMcpServer(this.deps.configDir, name, commandOrUrl, '');
    if (!ok) { this.json(res, 400, { error: 'invalid_body' }); return; }
    this.json(res, 200, { ok: true });
  }

  private async deleteMcp(req: http.IncomingMessage, res: http.ServerResponse, name: string): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const entry = listMcpServersFile(this.deps.configDir).find((s) => s.name === name);
    if (!entry) { this.json(res, 404, { error: 'not_found' }); return; }
    // source==='claude'(클로드 미러 소유)는 mcp-file.ts의 removeMcpServer도 내부적으로 거부하지만
    // 그건 조용한 no-op이라 그대로 두면 200을 돌려주게 된다 — 여기서 먼저 판별해 403으로 명시한다.
    if (entry.source === 'claude') { this.json(res, 403, { error: 'claude_managed' }); return; }
    removeMcpServer(this.deps.configDir, name);
    this.json(res, 200, { ok: true });
  }

  // ── 위키 API(서버 콘솔 S3 Task 2 — wiki-remote-file.ts 재사용) ─────────────────────────
  // 통계(pages·pendingProposals)는 overview()가 이미 쓰는 소스(wiki.listPages/proposals.listPending)를
  // 그대로 재사용한다 — 별도 캐시나 카운터를 새로 만들지 않는다(ponytail: 기존 소스 재사용).

  private async getWiki(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const form = readWikiRemoteFile(this.deps.configDir);
    // branch는 readWikiRemoteFile이 항상 기본값 'main'을 채워 돌려준다(파일 없어도) — url 없이
    // branch만 있는 건 의미 없는 상태라, url이 있을 때만 branch를 같이 실어 "remote 미설정"을
    // 빈 객체로 정직하게 표현한다.
    const remote: { url?: string; branch?: string } = {};
    if (form.remote) { remote.url = form.remote; remote.branch = form.branch; }
    const pages = (await this.deps.wiki.listPages()).length;
    const pendingProposals = (await this.deps.proposals.listPending()).length;
    this.json(res, 200, { remote, pages, pendingProposals });
  }

  private async saveWikiRemoteApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const parsed = await this.readBody(req);
    if (!parsed.ok) { this.json(res, 400, { error: 'bad_body' }); return; }
    const body = parsed.body as Record<string, unknown>;
    const url = typeof body.url === 'string' ? body.url : '';
    const branch = typeof body.branch === 'string' ? body.branch : '';
    // syncIntervalSec은 이 엔드포인트의 계약 밖(브리프: {url,branch}만) — 기존 값을 그대로 보존한다.
    const existing = readWikiRemoteFile(this.deps.configDir);
    saveWikiRemote(this.deps.configDir, { remote: url, branch, syncIntervalSec: existing.syncIntervalSec });
    this.json(res, 200, { ok: true });
  }

  // ── 서버 설정 API(서버 콘솔 S3 Task 2 — auth.config·chat.config·permissions-file 재사용) ──
  // ★보안 핵심: GET은 OIDC clientSecret 값을 절대 응답에 싣지 않는다(hasOidcSecret boolean만 —
  // 모델 api key와 동일한 "쓰기 전용" 계약, [[engram-project-state]] Critical 재발 방지 관성).
  // 포트/바인드 저장은 파일에만 반영되고 런타임 재바인드는 하지 않는다 — 헤드리스 서버는 재시작
  // 전까지 이전 바인드로 계속 뜬다(플랜 Global Constraints: "재시작 시 적용").

  private async getServerSettings(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const auth = loadAuthSettings(this.deps.configDir);
    const chatCfg = loadChatConfig(this.deps.configDir);
    const codingMode = getCommandMode(this.deps.configDir);
    // exposure: bind는 실제로 127.0.0.1/0.0.0.0 두 값뿐(플랜 Global Constraints) — 'lan'과 'internet'은
    // 둘 다 0.0.0.0으로 접히는 UI 의도라 저장된 bind만으로는 구분이 불가능하다. 별도 힌트 필드를
    // 새로 만들지 않고(YAGNI) 0.0.0.0은 항상 'lan'으로 조회되게 한다 — POST는 'internet'도 받아
    // 같은 bind로 저장하되(안내 문구는 콘솔 쪽 책임), 조회 시엔 'lan'으로 보인다(문서화된 한계).
    const exposure: 'local' | 'lan' = chatCfg.bind === '127.0.0.1' ? 'local' : 'lan';
    const body: Record<string, unknown> = {
      port: chatCfg.port,
      bind: chatCfg.bind,
      exposure,
      hasOidcSecret: !!(auth.oidc && auth.oidc.clientSecret),
      codingMode,
    };
    if (auth.serverName) body.serverName = auth.serverName;
    if (auth.oidc) {
      body.oidcIssuer = auth.oidc.issuer;
      body.oidcClientId = auth.oidc.clientId;
    }
    // ★단언 가능 지점: 위 어디에도 auth.oidc.clientSecret을 body에 담는 코드가 없다.
    this.json(res, 200, body);
  }

  private async saveServerSettings(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const parsed = await this.readBody(req);
    if (!parsed.ok) { this.json(res, 400, { error: 'bad_body' }); return; }
    const body = parsed.body as Record<string, unknown>;

    // codingMode: permissions-file.CommandMode 실제 값(auto/allowlist/off)만 허용 — 브리프 문구의
    // 'restricted'는 실제 파일 헬퍼엔 없는 값이라 여기선 진짜 타입을 따른다(house rule: 코드가 근거).
    let codingMode: CommandMode | undefined;
    if (body.codingMode !== undefined) {
      if (body.codingMode !== 'auto' && body.codingMode !== 'allowlist' && body.codingMode !== 'off') {
        this.json(res, 400, { error: 'invalid_coding_mode' }); return;
      }
      codingMode = body.codingMode;
    }

    // exposure→bind 매핑. bind를 직접 보내면 그 값이 exposure 파생값보다 우선(더 구체적인 입력).
    // ★bind는 화이트리스트: 127.0.0.1(local) 또는 0.0.0.0(lan/internet)만 허용.
    let bind: string | undefined;
    if (typeof body.exposure === 'string') {
      if (body.exposure === 'local') bind = '127.0.0.1';
      else if (body.exposure === 'lan' || body.exposure === 'internet') bind = '0.0.0.0';
      else { this.json(res, 400, { error: 'invalid_exposure' }); return; }
    }
    if (typeof body.bind === 'string' && body.bind.trim()) {
      const b = body.bind.trim();
      if (b !== '127.0.0.1' && b !== '0.0.0.0') { this.json(res, 400, { error: 'invalid_bind' }); return; }
      bind = b;
    }

    // ★port: 숫자 또는 숫자 문자열만 허용(boolean/object 거부).
    let port: number | undefined;
    if (body.port !== undefined) {
      if (typeof body.port === 'boolean' || typeof body.port === 'object') {
        this.json(res, 400, { error: 'invalid_port' }); return;
      }
      const n = Number(body.port);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) { this.json(res, 400, { error: 'invalid_port' }); return; }
      port = n;
    }

    if (port !== undefined || bind !== undefined) {
      saveChatBootConfig(this.deps.configDir, { port, bind });
    }
    if (codingMode !== undefined) setCommandMode(this.deps.configDir, codingMode);

    // serverName·oidc는 auth.json 하나에 같이 산다(saveAuthSettings가 부분patch가 아니라 전체
    // 스냅샷 쓰기라 — auth.config.ts) 먼저 기존 값을 읽어 병합해야 한다. clientSecret 빈값은
    // "기존 값 보존"(★보안 요구: 브라우저가 시크릿 원문을 몰라도 다른 필드만 바꿔 저장할 수 있어야 함).
    if (typeof body.serverName === 'string' || (body.oidc && typeof body.oidc === 'object')) {
      const existing = loadAuthSettings(this.deps.configDir);
      const next: AuthSettings = { ...existing };
      if (typeof body.serverName === 'string') {
        const trimmed = body.serverName.trim();
        if (trimmed) next.serverName = trimmed; else delete next.serverName;
      }
      if (body.oidc && typeof body.oidc === 'object') {
        const o = body.oidc as Record<string, unknown>;
        // ★OIDC 부분 업데이트: 빈값이면 기존 값 보존(clientSecret 보안 요구와 일관성).
        // 필드가 없거나 빈값이면 기존 값 사용, 신규값이면 그것으로 업데이트.
        const issuer = (typeof o.issuer === 'string' && o.issuer) ? o.issuer : (existing.oidc?.issuer ?? '');
        const clientId = (typeof o.clientId === 'string' && o.clientId) ? o.clientId : (existing.oidc?.clientId ?? '');
        const clientSecretInput = typeof o.clientSecret === 'string' ? o.clientSecret : '';
        const clientSecret = clientSecretInput || (existing.oidc?.clientSecret ?? '');
        next.oidc = { issuer, clientId, clientSecret };
      }
      saveAuthSettings(this.deps.configDir, next);
    }

    this.json(res, 200, { ok: true });
  }

  // ── 클라이언트 배포(preset) API(서버 콘솔 S3 Task 2 — preset-file.ts 재사용) ────────────────
  // 다운로드 강제(Content-Disposition: attachment)로 브라우저가 저장 대화상자를 띄우게 한다 —
  // 이 파일을 받은 클라이언트가 자기 configDir에 preset.json으로 두면 desktop/main.ts가 그대로
  // 읽어 접속을 시드한다(readPresetFile — 같은 셰이프 계약).

  private async getPreset(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const acc = this.requireOwner(req, res);
    if (!acc) return;
    const chatCfg = loadChatConfig(this.deps.configDir);
    const hostHint = this.hostnameFromHostHeader(req.headers.host);
    const preset = buildPreset(this.deps.configDir, { bind: chatCfg.bind, port: chatCfg.port, hostHint });
    const payload = JSON.stringify(preset, null, 2);
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="preset.json"',
    });
    res.end(payload);
  }

  // Host 헤더("host:port" 또는 "host")에서 호스트명만 뽑는다. bind=0.0.0.0일 때 서버 프로세스가
  // 스스로의 LAN IP를 신뢰성 있게 알 방법이 없어(멀티 NIC 등) 요청이 실제로 도달한 호스트명을
  // 최선의 힌트로 재사용한다(브리프: "간단하게, 문서화"). IPv6 리터럴("[::1]:47800")은 대괄호
  // 그대로 둔 채 포트만 떼어낸다 — 콜론 split이 깨지는 경우라 별도 분기.
  private hostnameFromHostHeader(hostHeader?: string): string | undefined {
    if (!hostHeader) return undefined;
    if (hostHeader.startsWith('[')) {
      const end = hostHeader.indexOf(']');
      return end >= 0 ? hostHeader.slice(0, end + 1) : hostHeader;
    }
    return hostHeader.split(':')[0];
  }
}
