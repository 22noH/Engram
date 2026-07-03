import * as fs from 'fs';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { MessengerPort, MentionEvent, ReplyTarget } from './messenger.port';
import { ChatStore } from './chat-store';
import { ChatConfig } from './chat.config';

// 자체 메신저 어댑터(Phase 9, 스펙 §4.1). http(chat.html 서빙)+ws 서버 내장.
// 생성자는 비연결 — 리슨은 start()에서(Discord 어댑터 관례).
// 기본 바인딩 127.0.0.1 — 인증 없음. 개방(0.0.0.0)은 9b(토큰 인증)까지 금지(README 명시).

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

  constructor(
    private readonly cfg: ChatConfig,
    private readonly store: ChatStore,
    private readonly opts: {
      htmlPath?: string;
      engramName?: string;
      logger: { warn(msg: string, ctx?: string): void };
    },
  ) {}

  onMention(handler: (e: MentionEvent) => Promise<void>): void {
    this.handler = handler;
  }
  onMessage(handler: (e: MentionEvent) => Promise<void>): void {
    this.msgHandler = handler;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        try {
          const html = fs.readFileSync(this.opts.htmlPath ?? '', 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        } catch { /* 아래 404 */ }
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => {
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

  private sendTo(ws: WebSocket, frame: unknown): void {
    try { ws.send(JSON.stringify(frame)); } catch { /* 격리 */ }
  }
  private broadcast(frame: unknown): void {
    const data = JSON.stringify(frame);
    for (const c of this.wss?.clients ?? []) {
      if (c.readyState === WebSocket.OPEN) {
        try { c.send(data); } catch { /* 격리 */ }
      }
    }
  }

  private async handleFrame(ws: WebSocket, raw: string): Promise<void> {
    let f: Record<string, unknown>;
    try { f = JSON.parse(raw) as Record<string, unknown>; } catch { return; } // 손상 무시
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
          if (typeof f.name === 'string') this.store.createChannel(f.name);
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
    const msg = this.store.appendMessage(channelId, {
      authorId: typeof f.authorId === 'string' && f.authorId ? f.authorId : 'owner',
      text,
      threadId: typeof f.threadId === 'string' && f.threadId ? f.threadId : undefined,
    });
    if (!msg) return;
    this.broadcast({ t: 'msg', channelId, message: msg });

    const name = this.opts.engramName ?? 'Engram';
    const isMention = ch.respondMode !== 'mention' || hasEngramMention(text, name);
    const anchor = msg.threadId ?? msg.id;
    const e: MentionEvent = {
      text: stripEngramMention(text, name),
      channelId,
      threadId: msg.threadId, // 본류면 undefined → bridge threadKey=channelId(Discord 의미론)
      authorId: msg.authorId,
      target: { channelId, anchorId: anchor } satisfies SelfTarget as ReplyTarget,
    };
    if (isMention) {
      if (this.handler) await this.handler(e);
    } else if (this.msgHandler) {
      await this.msgHandler(e); // 관찰 — 정책 필터는 bridge 몫(어댑터는 정책을 모른다)
    }
  }

  async reply(target: ReplyTarget, text: string): Promise<void> {
    const t = target as SelfTarget;
    const msg = this.store.appendMessage(t.channelId, { authorId: 'engram', text, threadId: t.anchorId });
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
