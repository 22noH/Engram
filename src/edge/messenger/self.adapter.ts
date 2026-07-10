import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerFrame, Action } from '../../../shared/protocol';
import { MessengerPort, MentionEvent, ReplyTarget } from './messenger.port';
import { ChatStore } from './chat-store';
import { ChatConfig } from './chat.config';
import { DEFAULT_USER } from '../../pal/path-resolver';
import type { WikiEngine } from '../../knowledge-core/wiki/wiki-engine';
import type { WikiPage } from '../../knowledge-core/wiki/page.types';
import type { ProposalStore, Proposal } from '../../knowledge-core/proposal-store';
import type { ProposalApplier } from '../proposal-applier';
import type { WikiPageMeta, WikiPageDto, ProposalDto } from '../../../shared/protocol';

interface WikiDeps { wiki: WikiEngine; proposals: ProposalStore; applier: ProposalApplier }

function toPageMeta(p: WikiPage): WikiPageMeta {
  return { slug: p.slug, title: p.frontmatter.title, category: p.frontmatter.category, status: p.frontmatter.status, updated: p.frontmatter.updated };
}
function toPageDto(p: WikiPage): WikiPageDto {
  return { ...toPageMeta(p), body: p.body };
}
function toProposalDto(p: Proposal): ProposalDto {
  return { id: p.id, op: p.op, targetSlug: p.targetSlug, title: p.title, category: p.category, payload: p.payload, sources: p.sources, importance: p.importance, confidence: p.verdict.confidence, reason: p.verdict.reason, ...(p.verdict.conflictSlugs ? { conflictSlugs: p.verdict.conflictSlugs } : {}) };
}

// 자체 메신저 어댑터(Phase 9, 스펙 §4.1). http(헬스 프로브)+ws 서버 내장.
// 생성자는 비연결 — 리슨은 start()에서(Discord 어댑터 관례).
// 기본 바인딩 127.0.0.1. token(chat.json/ENGRAM_CHAT_TOKEN) 설정 시 모든 연결이 auth 프레임 필요(Phase 13).
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

  constructor(
    private readonly cfg: ChatConfig,
    private readonly store: ChatStore,
    private readonly opts: {
      engramName?: string;
      logger: { warn(msg: string, ctx?: string): void };
    },
    private readonly wikiDeps?: WikiDeps,
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
      if (!this.cfg.token) {
        this.authed.add(ws); // 무인증 모드: 즉시 통과(현행 동작)
      } else {
        const timer = setTimeout(() => {
          if (!this.authed.has(ws)) {
            this.sendTo(ws, { t: 'authErr' });
            try { ws.close(); } catch { /* 격리 */ }
          }
        }, 5000);
        ws.once('close', () => clearTimeout(timer));
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

  private async handleFrame(ws: WebSocket, raw: string): Promise<void> {
    let f: Record<string, unknown>;
    try { f = JSON.parse(raw) as Record<string, unknown>; } catch { return; } // 손상 무시
    if (this.cfg.token && !this.authed.has(ws)) {
      if (f?.t === 'auth' && f.token === this.cfg.token) {
        this.authed.add(ws); // 승격 — 이후 정상 처리
      } else {
        this.sendTo(ws, { t: 'authErr' });
        try { ws.close(); } catch { /* 격리 */ }
      }
      return;
    }
    try {
      switch (f?.t) {
        case 'send': return await this.onSend(ws, f);
        case 'history': {
          const channelId = typeof f.channelId === 'string' ? f.channelId : '';
          const before = typeof f.before === 'string' ? f.before : undefined;
          this.sendTo(ws, { t: 'history', channelId, messages: this.store.history(channelId, { before }) });
          return;
        }
        case 'channels':
          this.sendTo(ws, { t: 'channels', list: this.store.listChannels() });
          return;
        case 'createChannel':
          if (typeof f.name === 'string') this.store.createChannel(f.name, f.mode === 'code' ? 'code' : f.mode === 'team' ? 'team' : 'chat');
          this.broadcast({ t: 'channels', list: this.store.listChannels() });
          return;
        case 'setRepoPath':
          if (typeof f.id === 'string' && typeof f.repoPath === 'string') this.store.setRepoPath(f.id, f.repoPath);
          this.broadcast({ t: 'channels', list: this.store.listChannels() });
          return;
        case 'deleteChannel':
          if (typeof f.id === 'string') this.store.deleteChannel(f.id);
          this.broadcast({ t: 'channels', list: this.store.listChannels() });
          return;
        case 'setRespondMode':
          if (typeof f.id === 'string' && (f.mode === 'all' || f.mode === 'mention')) {
            this.store.setRespondMode(f.id, f.mode);
          }
          this.broadcast({ t: 'channels', list: this.store.listChannels() });
          return;
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
        case 'proposalsList': {
          if (!this.wikiDeps) return;
          const list = (await this.wikiDeps.proposals.listPending(DEFAULT_USER)).map(toProposalDto);
          this.sendTo(ws, { t: 'proposals', list });
          return;
        }
        case 'proposalApprove': {
          if (!this.wikiDeps || typeof f.id !== 'string') return;
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
          const p = await this.wikiDeps.proposals.get(f.id);
          if (!p || p.status !== 'pending') return;
          await this.wikiDeps.applier.reject(p);
          this.broadcast({ t: 'proposalsChanged' });
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
    // 자가선언 이름 수용. 단 'engram'은 예약(사람이 Engram 사칭 방지) → owner로 강등.
    let author = typeof f.authorId === 'string' && f.authorId ? f.authorId : 'owner';
    if (author.trim().toLowerCase() === 'engram') author = 'owner';
    const msg = this.store.appendMessage(channelId, {
      authorId: author,
      text,
      threadId: typeof f.threadId === 'string' && f.threadId ? f.threadId : undefined,
    });
    if (!msg) return;
    this.broadcast({ t: 'msg', channelId, message: msg });

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
    if (msg) this.broadcast({ t: 'msg', channelId: t.channelId, message: msg });
  }

  async postToChannel(channelId: string, text: string, threadId?: string): Promise<void> {
    const msg = this.store.appendMessage(channelId, { authorId: 'engram', text, threadId });
    if (msg) this.broadcast({ t: 'msg', channelId, message: msg });
  }

  async stop(): Promise<void> {
    for (const c of this.wss?.clients ?? []) {
      try { c.terminate(); } catch { /* 무시 */ }
    }
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
