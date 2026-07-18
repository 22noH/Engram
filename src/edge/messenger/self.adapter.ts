import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerFrame, Action } from '../../../shared/protocol';
import { MessengerPort, MentionEvent, ReplyTarget } from './messenger.port';
import { ChatStore } from './chat-store';
import type { ChatChannel } from './chat-store';
import { ChatConfig } from './chat.config';
import { DEFAULT_USER } from '../../pal/path-resolver';
import type { WikiEngine } from '../../knowledge-core/wiki/wiki-engine';
import type { WikiPage } from '../../knowledge-core/wiki/page.types';
import type { ProposalStore, Proposal } from '../../knowledge-core/proposal-store';
import type { ProposalApplier } from '../proposal-applier';
import type { WikiPageMeta, WikiPageDto, ProposalDto, AdminUserDto, AdminSettings } from '../../../shared/protocol';
import type { AccountStore, Account } from '../auth/account-store';
import type { SessionStore } from '../auth/session-store';
import type { AuthHttp } from '../auth/auth-http';
import type { AuthSettings } from '../auth/auth.config';
import { can, type Permission } from '../auth/permissions';
import type { McpDeps } from '../mcp/engram-mcp';
import { buildMcpServer } from '../mcp/engram-mcp';
import { isLoopback, handleMcpRequest } from '../mcp/mcp-http';
import { makeMcpProposals } from '../mcp/mcp-proposals';

interface WikiDeps { wiki: WikiEngine; proposals: ProposalStore; applier: ProposalApplier }

// Phase 16a 계정 세션 게이트 의존성. 미주입 시 무인증(현행 — 테스트·brain 모드).
export interface AuthDeps {
  accounts: AccountStore; sessions: SessionStore; http: AuthHttp;
  settings: { load(): AuthSettings; save(s: AuthSettings): void };
}

function toPageMeta(p: WikiPage): WikiPageMeta {
  return { slug: p.slug, title: p.frontmatter.title, category: p.frontmatter.category, status: p.frontmatter.status, updated: p.frontmatter.updated };
}
function toPageDto(p: WikiPage): WikiPageDto {
  return { ...toPageMeta(p), body: p.body };
}
function toProposalDto(p: Proposal): ProposalDto {
  return { id: p.id, op: p.op, targetSlug: p.targetSlug, title: p.title, category: p.category, payload: p.payload, sources: p.sources, importance: p.importance, confidence: p.verdict.confidence, reason: p.verdict.reason, ...(p.verdict.conflictSlugs ? { conflictSlugs: p.verdict.conflictSlugs } : {}) };
}

// 자체 메신저 어댑터(Phase 9, 스펙 §4.1). http(헬스 프로브+/auth/*)+ws 서버 내장.
// 생성자는 비연결 — 리슨은 start()에서(Discord 어댑터 관례).
// 기본 바인딩 127.0.0.1. authDeps 주입 시 모든 연결이 계정 세션 auth 프레임 필요(Phase 16a —
// Phase 13 공유 토큰 게이트를 대체). authDeps 미주입=무인증(현행, 테스트·brain 모드).
// 인터넷 노출은 여전히 TLS 앞단(터널/리버스 프록시)이 필수 — Engram은 릴레이/TLS를 제공하지 않는다.

export interface SelfTarget {
  channelId: string;
  anchorId: string; // Engram 답이 매달릴 스레드 anchor(표시용 — 작업추적 키 아님)
}

export function hasEngramMention(text: string, name = 'Engram'): boolean {
  return text.toLowerCase().includes('@' + name.toLowerCase());
}
export function stripEngramMention(text: string, name = 'Engram'): string {
  return text.replace(new RegExp('@' + name, 'gi'), '').trim();
}

export class SelfMessenger implements MessengerPort {
  private server?: http.Server;
  private wss?: WebSocketServer;
  private handler?: (e: MentionEvent) => Promise<void>;
  private msgHandler?: (e: MentionEvent) => Promise<void>;
  private authed = new WeakSet<WebSocket>();
  private approving = new Set<string>();
  private users = new Map<WebSocket, Account>(); // 인증 소켓 → 계정(세션 모드)

  constructor(
    private readonly cfg: ChatConfig,
    private readonly store: ChatStore,
    private readonly opts: {
      engramName?: string;
      logger: { warn(msg: string, ctx?: string): void };
      // Task 3: 등록된 두뇌 이름 목록(configDir 접근은 main.ts 몫 — 여기는 주입만 받는다).
      // 미주입 시 빈 목록(무등록=setChannelBrain은 항상 무시, channels 응답의 brainNames=[]).
      brainNames?: () => string[];
      // Task 4(리뷰 지적): 현재 기본 두뇌 이름. brainNames와 같은 결로 요청마다 재조회(캐시 금지).
      // 미주입 시 ''(안전 폴백 — channels 응답의 defaultBrain='').
      defaultBrain?: () => string;
    },
    private readonly wikiDeps?: WikiDeps,
    private readonly authDeps?: AuthDeps,
    // Phase 8c-2: 메인 서버(isServer)에만 주입. 미주입(brain 모드·테스트)이면 /mcp는 404(현행과 동일).
    private readonly mcpDeps?: McpDeps,
  ) {}

  onMention(handler: (e: MentionEvent) => Promise<void>): void {
    this.handler = handler;
  }
  onMessage(handler: (e: MentionEvent) => Promise<void>): void {
    this.msgHandler = handler;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      // Phase 11: 클라(renderer/)가 페이지를 소유 — 두뇌 http는 헬스 프로브 + ws 업그레이드만.
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // Phase 16a: /auth/*는 AuthHttp로 위임(계정·세션 창구). authDeps 미주입=위임 없음(brain 모드).
      if (this.authDeps && (req.url ?? '').startsWith('/auth/')) {
        void this.authDeps.http.handle(req, res).catch(() => {
          try { res.writeHead(500); res.end(); } catch { /* 격리 */ }
        });
        return;
      }
      // Phase 8c-2: /mcp는 mcpDeps 주입 시에만(메인 서버) + 루프백 전용(원격은 팀 서버 모드라도 잠금).
      // 미주입이면 이 블록을 건너뛰어 기존 404로 떨어진다(현행 동일).
      // ★Server는 요청마다 새로 만든다(SDK stateless 참조 예제와 동일) — SDK Protocol.connect()는
      // 이전 transport가 닫히기 전 재연결 시 throw하므로, 싱글턴을 공유하면 동시 POST 2건이
      // 경합해 두 번째가 500이 된다(리뷰 재현). buildMcpServer는 순수·저비용이라 요청별 생성이 정답.
      if (this.mcpDeps && req.url === '/mcp') {
        if (!isLoopback(req.socket.remoteAddress)) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('forbidden — /mcp is loopback-only');
          return;
        }
        // §3.4: wikiDeps 있으면(메인 서버) 승인 도구 3종을 앱 /mcp에도 상시 노출 — ws 승인함(this.approving)과
        // ★같은 Set을 공유해 교차 경로(ws↔MCP) 이중승인을 원천 차단, onChanged로 ws 클라에도 실시간 브로드캐스트.
        // wiki_write는 this.mcpDeps.write에 이미 담겨 오면 그대로 흘려보낸다(주입은 main.ts 몫 — 여기 로직 없음).
        const deps: McpDeps = this.wikiDeps
          ? {
              ...this.mcpDeps,
              proposals: makeMcpProposals(this.wikiDeps.proposals, this.wikiDeps.applier, {
                approving: this.approving,
                onChanged: () => {
                  this.broadcast({ t: 'wikiChanged' });
                  this.broadcast({ t: 'proposalsChanged' });
                },
              }),
            }
          : this.mcpDeps;
        void handleMcpRequest(buildMcpServer(deps), req, res);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    this.wss = new WebSocketServer({ server: this.server });
    // ws는 http 서버의 error를 wss 'error'로 재방출한다. 리스너가 없으면 Node가 throw해 상주가 죽는다
    // (특히 EADDRINUSE). 여기서 흡수 → start()의 promise reject만 남고 상주는 생존(채팅만 비활성).
    this.wss.on('error', (err) => {
      this.opts.logger.warn(`웹소켓 서버 오류(채팅 비활성 가능): ${String(err)}`, 'SelfChat');
    });
    this.wss.on('connection', (ws) => {
      if (!this.authDeps) {
        this.authed.add(ws); // 무인증(테스트·brain 모드) — 현행 무토큰과 동일
      } else {
        const timer = setTimeout(() => {
          if (!this.authed.has(ws)) {
            this.sendTo(ws, { t: 'authErr' });
            try { ws.close(); } catch { /* 격리 */ }
          }
        }, 5000);
        ws.once('close', () => { clearTimeout(timer); this.users.delete(ws); this.authed.delete(ws); });
      }
      ws.on('message', (raw) => { void this.handleFrame(ws, String(raw)); });
      ws.on('error', () => { /* 접속 단위 격리 */ });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.cfg.port, this.cfg.bind, () => resolve());
    });
  }

  // 테스트용: port 0(임시 포트)로 리슨했을 때 실제 포트.
  addressPort(): number {
    const a = this.server?.address();
    return typeof a === 'object' && a ? a.port : this.cfg.port;
  }

  private sendTo(ws: WebSocket, frame: ServerFrame): void {
    try { ws.send(JSON.stringify(frame)); } catch { /* 격리 */ }
  }
  private broadcast(frame: ServerFrame): void {
    const data = JSON.stringify(frame);
    for (const c of this.wss?.clients ?? []) {
      if (c.readyState === WebSocket.OPEN && this.authed.has(c)) {
        try { c.send(data); } catch { /* 격리 */ }
      }
    }
  }
  // Phase 16c: 그 채널에 canAccessChannel 통과하는 인증 소켓에만 전송(공개면 canAccess=true → 전원).
  // 채널이 이미 삭제됐으면(ch undefined) 접근 판정을 건너뛰고 기존 broadcast처럼 전원에게 보낸다.
  private broadcastToChannel(channelId: string, frame: ServerFrame): void {
    const ch = this.store.listChannels().find((c) => c.id === channelId);
    const data = JSON.stringify(frame);
    for (const c of this.wss?.clients ?? []) {
      if (c.readyState !== WebSocket.OPEN || !this.authed.has(c)) continue;
      if (ch && !this.canAccessChannel(c, ch)) continue;
      try { c.send(data); } catch { /* 격리 */ }
    }
  }

  // Phase 16a: owner 전용 관리 프레임 집합. 비owner 소켓(또는 authDeps 미주입)의 admin 프레임은
  // 조용히 무시 — 응답도 로그도 없다(존재 유출 방지).
  private static readonly ADMIN_FRAMES = new Set([
    'adminUsers', 'adminApprove', 'adminSuspend', 'adminRestore',
    'adminResetPassword', 'adminForceLogout', 'adminGetSettings', 'adminSetSettings',
    'adminSetPermissions',
  ]);
  private adminGate(ws: WebSocket): boolean {
    const me = this.users.get(ws);
    return !!this.authDeps && me?.role === 'owner';
  }

  // Phase 16b: 세분 권한 게이트. authDeps 미주입(무인증 모드)이면 전부 통과(현행 유지 — 회귀 금지).
  private allowed(ws: WebSocket, perm: Permission): boolean {
    if (!this.authDeps) return true;
    return can(this.users.get(ws), perm);
  }
  // 채널 관리 게이트: channels.manage 보유 또는 그 채널을 만든 본인(소유권 예외).
  private canManageChannel(ws: WebSocket, ch: ChatChannel | undefined): boolean {
    if (!this.authDeps) return true;
    const me = this.users.get(ws);
    if (!me) return false;
    return can(me, 'channels.manage') || (!!ch?.creatorId && ch.creatorId === me.id);
  }
  // Phase 16c: 멤버 관리(visibility·memberIds) 게이트. 비공개 채널은 주인(creatorId)만 —
  // owner·channels.manage 예외 없음(감시 방지: 관리 권한이 비공개 채널 멤버를 "정할" 권리를 주지 않는다).
  // 공개 채널은 기존 16b canManageChannel 규칙을 그대로 따른다.
  private canAdminChannel(ws: WebSocket, ch: ChatChannel | undefined): boolean {
    if (!this.authDeps) return true;
    if (!ch) return false;
    if ((ch.visibility ?? 'public') === 'private') {
      const me = this.users.get(ws);
      return !!me && ch.creatorId === me.id;
    }
    return this.canManageChannel(ws, ch);
  }
  // Phase 16c: 채널 목록 가시성 게이트. authDeps 미주입(무인증)이면 전부 접근(회귀 금지).
  // 공개는 전원. 비공개는 만든 사람 본인 또는 초대된 멤버만 — owner·channels.manage 예외 없음
  // (감시 방지: 관리 권한이 비공개 채널을 "볼" 권리를 주지 않는다).
  private canAccessChannel(ws: WebSocket, ch: ChatChannel): boolean {
    if (!this.authDeps) return true;
    if ((ch.visibility ?? 'public') !== 'private') return true;
    const me = this.users.get(ws);
    if (!me) return false;
    return ch.creatorId === me.id || (ch.memberIds ?? []).includes(me.id);
  }
  // Task 3: 등록 두뇌 이름 목록(요청 시점 재조회 — 캐시 금지, 두뇌 추가 직후 반영).
  private brainNames(): string[] {
    return this.opts.brainNames ? this.opts.brainNames() : [];
  }
  // Task 4(리뷰 지적): 현재 기본 두뇌 이름(요청 시점 재조회, 미주입 시 '').
  private defaultBrain(): string {
    return this.opts.defaultBrain ? this.opts.defaultBrain() : '';
  }

  // 소켓별로 접근 가능한 채널만 담아 channels 프레임을 각 인증 소켓에 전송.
  private broadcastChannels(): void {
    const all = this.store.listChannels();
    const brainNames = this.brainNames();
    const defaultBrain = this.defaultBrain();
    for (const c of this.wss?.clients ?? []) {
      if (c.readyState !== WebSocket.OPEN || !this.authed.has(c)) continue;
      const list = this.authDeps ? all.filter((ch) => this.canAccessChannel(c, ch)) : all;
      try { c.send(JSON.stringify({ t: 'channels', list, brainNames, defaultBrain })); } catch { /* 격리 */ }
    }
  }
  private adminList(): AdminUserDto[] {
    return this.authDeps!.accounts.list().map((a) => ({
      id: a.id, displayName: a.displayName, role: a.role,
      loginId: a.loginId, status: a.status, createdAt: a.createdAt, sso: !!a.oidc,
      permissions: a.permissions ?? [],
    }));
  }
  private sendAdminList(ws: WebSocket): void {
    this.sendTo(ws, { t: 'adminUsers', list: this.adminList() });
  }

  private async handleFrame(ws: WebSocket, raw: string): Promise<void> {
    let f: Record<string, unknown>;
    try { f = JSON.parse(raw) as Record<string, unknown>; } catch { return; } // 손상 무시
    if (this.authDeps && !this.authed.has(ws)) {
      const sess = f?.t === 'auth' && typeof f.token === 'string' ? this.authDeps.sessions.resolve(f.token) : null;
      const acc = sess ? this.authDeps.accounts.get(sess.userId) : null;
      if (acc && acc.status === 'active') {
        this.authed.add(ws);
        this.users.set(ws, acc);
        this.sendTo(ws, { t: 'authOk', user: { id: acc.id, displayName: acc.displayName, role: acc.role, permissions: acc.permissions ?? [] } });
      } else {
        this.sendTo(ws, { t: 'authErr' });
        try { ws.close(); } catch { /* 격리 */ }
      }
      return;
    }
    if (typeof f?.t === 'string' && SelfMessenger.ADMIN_FRAMES.has(f.t) && !this.adminGate(ws)) return;
    try {
      switch (f?.t) {
        case 'send': return await this.onSend(ws, f);
        case 'history': {
          const channelId = typeof f.channelId === 'string' ? f.channelId : '';
          const before = typeof f.before === 'string' ? f.before : undefined;
          const ch = this.store.listChannels().find((c) => c.id === channelId);
          if (ch && !this.canAccessChannel(ws, ch)) { this.sendTo(ws, { t: 'history', channelId, messages: [] }); return; }
          this.sendTo(ws, { t: 'history', channelId, messages: this.store.history(channelId, { before }) });
          return;
        }
        case 'channels': {
          const all = this.store.listChannels();
          const list = this.authDeps ? all.filter((ch) => this.canAccessChannel(ws, ch)) : all;
          this.sendTo(ws, { t: 'channels', list, brainNames: this.brainNames(), defaultBrain: this.defaultBrain() });
          return;
        }
        case 'createChannel': {
          if (this.cfg.role === 'brain' && f.mode === 'team') return; // brain=개인 연산용, 팀 방 없음
          const me = this.users.get(ws);
          if (typeof f.name === 'string') {
            this.store.createChannel(
              f.name,
              f.mode === 'code' ? 'code' : f.mode === 'team' ? 'team' : 'chat',
              me?.id,
              f.visibility === 'private' ? 'private' : undefined,
            );
          }
          this.broadcastChannels();
          return;
        }
        case 'setRepoPath': {
          if (typeof f.id === 'string' && typeof f.repoPath === 'string') {
            const ch = this.store.listChannels().find((c) => c.id === f.id);
            if (this.canAdminChannel(ws, ch)) this.store.setRepoPath(f.id, f.repoPath);
          }
          this.broadcastChannels();
          return;
        }
        case 'deleteChannel': {
          if (typeof f.id === 'string') {
            const ch = this.store.listChannels().find((c) => c.id === f.id);
            if (this.canAdminChannel(ws, ch)) this.store.deleteChannel(f.id);
          }
          this.broadcastChannels();
          return;
        }
        case 'setRespondMode': {
          if (typeof f.id === 'string' && (f.mode === 'all' || f.mode === 'mention')) {
            const ch = this.store.listChannels().find((c) => c.id === f.id);
            if (this.canAdminChannel(ws, ch)) this.store.setRespondMode(f.id, f.mode);
          }
          this.broadcastChannels();
          return;
        }
        case 'setChannelBrain': {
          // Task 3: setRespondMode와 동일 권한 게이트(canAdminChannel). brain=null은 해제(검증 없이 허용),
          // 문자열이면 요청 시점에 등록 이름 목록을 재조회해 대조(캐시 금지) — 미등록/비문자열은 조용히 무시.
          if (typeof f.id === 'string' && (f.brain === null || typeof f.brain === 'string')) {
            const ch = this.store.listChannels().find((c) => c.id === f.id);
            if (this.canAdminChannel(ws, ch)) {
              if (f.brain === null) {
                this.store.setChannelBrain(f.id, null);
              } else {
                // chat-store.setChannelBrain은 저장 시 trim한다 — 여기 검증도 trim된 값으로 대조해야
                // 앞뒤 공백이 섞인 값(예: ' qwen ')이 store엔 저장될 값인데 ws에서만 미등록으로 오판되지 않는다.
                const trimmed = f.brain.trim();
                if (this.brainNames().includes(trimmed)) {
                  this.store.setChannelBrain(f.id, trimmed);
                }
              }
            }
          }
          this.broadcastChannels();
          return;
        }
        case 'wikiList': {
          if (!this.wikiDeps) return;
          const list = (await this.wikiDeps.wiki.listPages()).map(toPageMeta);
          this.sendTo(ws, { t: 'wikiPages', list });
          return;
        }
        case 'wikiGet': {
          if (!this.wikiDeps || typeof f.slug !== 'string') return;
          const page = await this.wikiDeps.wiki.getPage(f.slug);
          if (!page) { this.sendTo(ws, { t: 'error', text: 'unknown page' }); return; }
          this.sendTo(ws, { t: 'wikiPage', page: toPageDto(page) });
          return;
        }
        case 'wikiSearch': {
          if (!this.wikiDeps || typeof f.query !== 'string') return;
          const hits = await this.wikiDeps.wiki.search(f.query);
          const list = hits.map((h) => ({ slug: h.slug, title: h.title, snippet: h.text, score: h.score }));
          this.sendTo(ws, { t: 'wikiResults', query: f.query, list });
          return;
        }
        case 'wikiUnpublish': {
          if (!this.wikiDeps || typeof f.slug !== 'string') return;
          if (!this.allowed(ws, 'wiki.unpublish')) return; // 무권한 조용히 무시
          await this.wikiDeps.wiki.unpublishPage(f.slug);
          this.broadcast({ t: 'wikiChanged' });
          return;
        }
        case 'wikiEdit': {
          if (!this.wikiDeps || typeof f.slug !== 'string' || typeof f.body !== 'string') return;
          if (!this.allowed(ws, 'wiki.edit')) return;
          await this.wikiDeps.wiki.editPage(f.slug, f.body);
          this.broadcast({ t: 'wikiChanged' });
          return;
        }
        case 'wikiDelete': {
          if (!this.wikiDeps || typeof f.slug !== 'string') return;
          if (!this.allowed(ws, 'wiki.delete')) return;
          await this.wikiDeps.wiki.deletePage(f.slug);
          this.broadcast({ t: 'wikiChanged' });
          return;
        }
        case 'proposalsList': {
          if (!this.wikiDeps) return;
          const list = (await this.wikiDeps.proposals.listPending(DEFAULT_USER)).map(toProposalDto);
          this.sendTo(ws, { t: 'proposals', list });
          return;
        }
        case 'proposalApprove': {
          if (!this.wikiDeps || typeof f.id !== 'string') return;
          if (!this.allowed(ws, 'wiki.approve')) return;   // 무권한 무시
          if (this.approving.has(f.id)) return;  // 동시 승인 창 — 중복 반영 차단
          this.approving.add(f.id);              // 동기 마킹(다음 요청이 즉시 봄)
          try {
            const p = await this.wikiDeps.proposals.get(f.id);
            if (!p || p.status !== 'pending') return; // 없거나 이미 처리 — 조용히 무시
            await this.wikiDeps.applier.apply(p);
            this.broadcast({ t: 'wikiChanged' });
            this.broadcast({ t: 'proposalsChanged' });
          } finally {
            this.approving.delete(f.id);
          }
          return;
        }
        case 'proposalReject': {
          if (!this.wikiDeps || typeof f.id !== 'string') return;
          if (!this.allowed(ws, 'wiki.approve')) return;   // 무권한 무시
          const p = await this.wikiDeps.proposals.get(f.id);
          if (!p || p.status !== 'pending') return;
          await this.wikiDeps.applier.reject(p);
          this.broadcast({ t: 'proposalsChanged' });
          return;
        }
        case 'adminUsers':
          this.sendAdminList(ws);
          return;
        case 'adminApprove': {
          if (typeof f.id === 'string') {
            const t = this.authDeps!.accounts.get(f.id);
            if (t?.status === 'pending') this.authDeps!.accounts.setStatus(f.id, 'active');
          }
          this.sendAdminList(ws);
          return;
        }
        case 'adminSuspend': {
          if (typeof f.id === 'string') {
            const t = this.authDeps!.accounts.get(f.id);
            if (t && t.role !== 'owner') {
              this.authDeps!.accounts.setStatus(f.id, 'suspended');
              this.authDeps!.sessions.revokeAllFor(f.id);
              this.kickUser(f.id);
            }
          }
          this.sendAdminList(ws);
          return;
        }
        case 'adminRestore': {
          if (typeof f.id === 'string') {
            const t = this.authDeps!.accounts.get(f.id);
            if (t?.status === 'suspended') this.authDeps!.accounts.setStatus(f.id, 'active');
          }
          this.sendAdminList(ws);
          return;
        }
        case 'adminResetPassword': {
          if (typeof f.id === 'string' && typeof f.password === 'string' && f.password) {
            this.authDeps!.accounts.setPassword(f.id, f.password);
          }
          this.sendAdminList(ws);
          return;
        }
        case 'adminForceLogout': {
          if (typeof f.id === 'string') {
            this.authDeps!.sessions.revokeAllFor(f.id);
            this.kickUser(f.id);
          }
          this.sendAdminList(ws);
          return;
        }
        case 'adminGetSettings':
          this.sendTo(ws, { t: 'adminSettings', settings: this.authDeps!.settings.load() });
          return;
        case 'adminSetSettings':
          if (f.settings && typeof f.settings === 'object') {
            this.authDeps!.settings.save(f.settings as AdminSettings);
          }
          this.sendTo(ws, { t: 'adminSettings', settings: this.authDeps!.settings.load() });
          return;
        case 'adminSetPermissions': {
          if (typeof f.id === 'string' && Array.isArray(f.permissions)) {
            this.authDeps!.accounts.setPermissions(f.id, f.permissions as Permission[]);
          }
          this.sendAdminList(ws);
          return;
        }
        case 'setChannelVisibility': {
          if (typeof f.id === 'string' && (f.visibility === 'public' || f.visibility === 'private')) {
            const ch = this.store.listChannels().find((c) => c.id === f.id);
            if (this.canAdminChannel(ws, ch)) this.store.setVisibility(f.id, f.visibility);
          }
          this.broadcastChannels();
          return;
        }
        case 'setChannelMembers': {
          if (typeof f.id === 'string' && Array.isArray(f.memberIds)) {
            const ch = this.store.listChannels().find((c) => c.id === f.id);
            if (this.canAdminChannel(ws, ch)) {
              const valid = this.authDeps
                ? (f.memberIds as unknown[]).filter((x): x is string => typeof x === 'string' && !!this.authDeps!.accounts.get(x))
                : [];
              this.store.setMembers(f.id, valid);
            }
          }
          this.broadcastChannels();
          return;
        }
        case 'channelRoster': {
          const list = this.authDeps
            ? this.authDeps.accounts.list().filter((a) => a.status === 'active').map((a) => ({ id: a.id, displayName: a.displayName }))
            : [];
          this.sendTo(ws, { t: 'roster', list });
          return;
        }
        default: return; // 미지 타입 무시(스펙 §6)
      }
    } catch (err) {
      this.opts.logger.warn(`프레임 처리 실패: ${String(err)}`, 'SelfChat');
    }
  }

  private async onSend(ws: WebSocket, f: Record<string, unknown>): Promise<void> {
    const text = typeof f.text === 'string' ? f.text : '';
    const channelId = typeof f.channelId === 'string' ? f.channelId : '';
    if (!text.trim() || !channelId) return;
    const ch = this.store.listChannels().find((c) => c.id === channelId);
    if (!ch) { this.sendTo(ws, { t: 'error', text: 'unknown channel' }); return; }
    if (!this.canAccessChannel(ws, ch)) return; // 비공개 비접근 → 조용히 무시(기록 안 함)
    // 작성자는 서버가 세션에서 찍는다(Phase 16a) — 클라 authorId 주장은 무시(Phase 14 자가선언 폐기).
    const me = this.users.get(ws);
    const msg = this.store.appendMessage(channelId, {
      authorId: me ? me.id : 'owner',
      ...(me ? { authorName: me.displayName } : {}),
      text,
      threadId: typeof f.threadId === 'string' && f.threadId ? f.threadId : undefined,
    });
    if (!msg) return;
    this.broadcastToChannel(channelId, { t: 'msg', channelId, message: msg });

    const name = this.opts.engramName ?? 'Engram';
    const isMention = ch.respondMode !== 'mention' || hasEngramMention(text, name);
    const anchor = msg.threadId ?? msg.id;
    // threadId는 항상 미설정 — self의 스레드는 표시 개념일 뿐, 작업 키(threadKey)는 채널이다.
    // Discord도 스레드=자체 channelId라 threadId를 안 채운다(동일 의미론). 이걸 anchor로 채우면
    // 스레드 안 승인 답장이 pending(채널 키)을 못 찾고, 재개 예약이 anchor를 채널로 오인한다.
    const e: MentionEvent = {
      text: stripEngramMention(text, name),
      channelId,
      authorId: msg.authorId,
      target: { channelId, anchorId: anchor } satisfies SelfTarget as ReplyTarget,
      ...(ch.mode === 'code' ? { mode: 'code' as const, repoPath: ch.repoPath } : {}),
      ...(ch.brain ? { brain: ch.brain } : {}), // 스펙 §3.2: 채널의 brain을 이벤트에 실어나름(미설정 채널=회귀 0)
    };
    if (isMention) {
      if (this.handler) await this.handler(e);
    } else if (this.msgHandler) {
      await this.msgHandler(e); // 관찰 — 정책 필터는 bridge 몫(어댑터는 정책을 모른다)
    }
  }

  async reply(target: ReplyTarget, text: string, actions?: Action[]): Promise<void> {
    const t = target as SelfTarget;
    const msg = this.store.appendMessage(t.channelId, { authorId: 'engram', text, threadId: t.anchorId, ...(actions ? { actions } : {}) });
    if (msg) this.broadcastToChannel(t.channelId, { t: 'msg', channelId: t.channelId, message: msg });
  }

  async postToChannel(channelId: string, text: string, threadId?: string): Promise<void> {
    const msg = this.store.appendMessage(channelId, { authorId: 'engram', text, threadId });
    if (msg) this.broadcastToChannel(channelId, { t: 'msg', channelId, message: msg });
  }

  // Phase 16a: 관리자가 계정을 정지/삭제할 때 그 계정의 연결 소켓을 즉시 끊는다.
  kickUser(userId: string): void {
    for (const [ws, acc] of this.users) {
      if (acc.id === userId) {
        try { ws.close(); } catch { /* 격리 */ }
        this.users.delete(ws);
        // authed에서도 함께 제거 — 안 그러면 close()의 비동기 핸드셰이크 동안 이미 파싱된
        // in-flight 'message'가 게이트(handleFrame의 !authed.has(ws))를 통과해 users.get(ws)가
        // undefined인 채로 처리되며 'owner'로 오귀속된다.
        this.authed.delete(ws);
      }
    }
  }

  async stop(): Promise<void> {
    for (const c of this.wss?.clients ?? []) {
      try { c.terminate(); } catch { /* 무시 */ }
    }
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
