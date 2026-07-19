import * as fs from 'fs';
import * as path from 'path';
import type * as http from 'http';
import type { AccountStore } from '../auth/account-store';
import type { SessionStore } from '../auth/session-store';
import type { ChatStore } from '../messenger/chat-store';
import type { WikiEngine } from '../../knowledge-core/wiki/wiki-engine';
import type { ProposalStore } from '../../knowledge-core/proposal-store';
import { resolveResourceDir } from '../../pal/resource-dir';

// /admin http 창구(서버 콘솔 S1, 플랜 docs/superpowers/plans/2026-07-19-server-console-s1.md Task 2).
// AuthHttp와 같은 결: 파싱/응답만, 로직은 store에 위임. self.adapter가 authDeps+adminDeps 둘 다
// 있을 때만 이리로 위임하므로(brain 모드·미주입=404 폴스루) 여기선 항상 세션 게이트가 유효하다고 가정한다.
// 정적 서빙: console/dist(패키징 경로 해석은 prompts/ 로딩 관성 — resolveResourceDir 재사용).

export interface AdminHttpDeps {
  accounts: AccountStore;
  sessions: SessionStore;
  chat: ChatStore;
  wiki: WikiEngine;
  proposals: ProposalStore;
  distDir?: string; // 테스트 주입용. 기본값은 resolveResourceDir('console/dist').
}

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
      if (url === '/admin/api/overview' && req.method === 'GET') {
        await this.overview(req, res);
      } else {
        this.notFound(res); // S1 범위 밖 api 경로
      }
      return true;
    }

    if (req.method !== 'GET') { this.notFound(res); return true; }
    this.serveStatic(url, res);
    return true;
  }

  // owner 세션 필수(스펙: Authorization: Bearer <token> → sessions.resolve → role==='owner'
  // 아니면 403; 계정 0(미설정 서버)은 토큰 검사보다 먼저 401 — 셋업 전에 데이터 노출 금지).
  private async overview(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const { accounts, sessions } = this.deps;
      if (accounts.count() === 0) { this.json(res, 401, { error: 'unconfigured' }); return; }
      const token = bearer(req);
      const sess = token ? sessions.resolve(token) : null;
      const acc = sess ? accounts.get(sess.userId) : null;
      if (!acc) { this.json(res, 401, { error: 'unauthorized' }); return; }
      if (acc.role !== 'owner') { this.json(res, 403, { error: 'forbidden' }); return; }

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
}
