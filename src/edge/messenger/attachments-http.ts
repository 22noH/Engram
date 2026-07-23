import * as fs from 'fs';
import type * as http from 'http';
import type { AccountStore } from '../auth/account-store';
import type { SessionStore } from '../auth/session-store';
import type { GroupStore } from '../auth/group-store';
import type { ChatStore } from './chat-store';
import { safeId } from './chat-store';
import type { AttachmentStore } from './attachment-store';
import { MAX_ATTACHMENT_BYTES } from './attachment-store';
import { isLoopback } from '../mcp/mcp-http';
import { accountCanAccessChannel } from './channel-access';

// /attachments/* http 창구(Task 2, 스펙 §데이터·전송). AuthHttp/AdminHttp와 같은 결: 파싱/응답만,
// 저장·조회 로직은 AttachmentStore/ChatStore에 위임. handle(req,res):Promise<boolean> 관례(자기
// 경로가 아니면 false — self.adapter가 다음 라우트로 폴스루).
//
// 게이트(스펙 §안전선 — 새 우회 경로 금지): 세션 bearer→sessions.resolve→계정(active), 단
// 계정 0개+루프백(localFree, auth-http.ts:99 관례)이면 게이트 생략. 채널 접근은 계정 기준
// accountCanAccessChannel(channel-access.ts) 재사용 — ws canAccessChannel과 동일 판정.
//
// CORS 개방(auth-http.ts와 동일 이유: 렌더러는 file://라 교차출처, 자격증명은 헤더로만 오가고
// 쿠키를 안 써 개방이 안전하다).

export interface AttachmentsHttpDeps {
  accounts: AccountStore;
  sessions: SessionStore;
  chat: ChatStore;
  attachments: AttachmentStore;
  groups?: GroupStore; // 서버 콘솔 S2 그룹 채널 접근(미주입=개인 판정만, 회귀 0)
}

// 이미지 화이트리스트(스펙): 다운로드 시 inline 디스포지션 대상 + Content-Type 그대로 반영 대상.
const IMAGE_MIME_WHITELIST = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// 다운로드 Content-Type 화이트리스트: 이미지 + text/plain(브리프 명시). 밖은 전부 octet-stream —
// 브라우저가 임의 mime을 신뢰해 실행/렌더하지 않도록 원본 mime을 무조건 반영하지 않는다.
const MIME_WHITELIST = new Set<string>([...IMAGE_MIME_WHITELIST, 'text/plain']);

function bearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

// 업로드 본문을 상한(20MB)까지만 누적한다. 초과 시 즉시 null로 정착(readBody hang 교훈 —
// auth-http T4: destroy() 하지 않고 흘려보내기만 해야 응답 왕복이 유지된다). close/abort/error도
// 미완결로 취급(null) — 부분 데이터를 완성본인 양 저장하지 않는다.
function readCappedBody(req: http.IncomingMessage, capBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: Buffer | null) => { if (!settled) { settled = true; resolve(v); } };
    const chunks: Buffer[] = [];
    let size = 0;
    let oversize = false;
    req.on('data', (c: Buffer) => {
      if (oversize) return; // 이미 정착 — 소켓은 파괴하지 않고 흘려보내기만(응답 왕복 유지)
      size += c.length;
      if (size > capBytes) { oversize = true; chunks.length = 0; settle(null); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!oversize) settle(Buffer.concat(chunks)); });
    req.on('error', () => settle(null));
    req.on('close', () => settle(null)); // destroy()/중단 시 'end'가 안 옴 — 정착 보장
    req.on('aborted', () => settle(null));
  });
}

export class AttachmentsHttp {
  constructor(private readonly deps: AttachmentsHttpDeps) {}

  private cors(res: http.ServerResponse): void {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, x-attachment-name, authorization');
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    try {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch { /* 응답 왕복 불가(소켓 이미 종료 등) — 격리 */ }
  }
  private fail(res: http.ServerResponse, status: number, error: string): void {
    this.json(res, status, { error });
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith('/attachments/')) return false;
    this.cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

    // never-throw: 예외가 나도 응답을 왕복시켜야 한다(readBody hang 교훈 — 상위 호출부가 항상
    // .catch를 걸어준다는 보장이 없다, self.adapter.spec의 테스트 하네스처럼 catch 없이 .then만
    // 거는 호출부도 있다). 여기서 흡수 못 하면 요청이 영구 미응답으로 남는다.
    try {
      // 경로: /attachments/<channelId>(POST) | /attachments/<channelId>/<id>(GET)
      const parts = url.split('/').filter(Boolean); // ['attachments', channelId, id?]
      const channelId = parts[1] ?? '';
      if (parts.length < 2 || parts.length > 3 || !safeId(channelId)) { this.fail(res, 400, 'bad request'); return true; }

      const { accounts, sessions, chat, groups } = this.deps;
      // 스탠드얼론 §2.1 localFree 재사용(auth-http.ts:99 관례): 계정 0개+루프백이면 게이트 생략.
      // 헤더는 절대 보지 않는다(신뢰 금지) — req.socket.remoteAddress만.
      const localFree = accounts.count() === 0 && isLoopback(req.socket.remoteAddress);
      let accountId: string | undefined;
      if (!localFree) {
        const token = bearer(req);
        const sess = token ? sessions.resolve(token) : null;
        const acc = sess ? accounts.get(sess.userId) : null;
        if (!acc || acc.status !== 'active') { this.fail(res, 401, 'unauthorized'); return true; }
        accountId = acc.id;
      }

      const ch = chat.listChannels().find((c) => c.id === channelId);
      if (!ch) { this.fail(res, 404, 'unknown channel'); return true; }
      if (!localFree && !accountCanAccessChannel(accountId, ch, groups)) { this.fail(res, 403, 'forbidden'); return true; }

      if (req.method === 'POST' && parts.length === 2) { await this.upload(req, res, channelId); return true; }
      if (req.method === 'GET' && parts.length === 3) { this.download(res, channelId, parts[2]); return true; }
      this.fail(res, 404, 'not found');
      return true;
    } catch {
      if (!res.headersSent) this.fail(res, 500, 'internal');
      else { try { res.end(); } catch { /* 격리 */ } }
      return true;
    }
  }

  // 업로드: raw body(Content-Type 헤더=mime, x-attachment-name 헤더=encodeURIComponent'd 파일명).
  // 개수 상한(메시지당 5개)은 여기서 강제하지 않는다 — send 시점(Task 3) 몫. 여긴 크기 상한만.
  private async upload(req: http.IncomingMessage, res: http.ServerResponse, channelId: string): Promise<void> {
    const buf = await readCappedBody(req, MAX_ATTACHMENT_BYTES);
    if (buf === null) { this.fail(res, 413, 'too large'); return; }
    const mime = typeof req.headers['content-type'] === 'string' && req.headers['content-type']
      ? req.headers['content-type']
      : 'application/octet-stream';
    const rawName = req.headers['x-attachment-name'];
    let name = 'file';
    if (typeof rawName === 'string' && rawName) {
      try { const d = decodeURIComponent(rawName); if (d) name = d; } catch { /* 손상 인코딩 — 폴백 'file' */ }
    }
    const meta = this.deps.attachments.save(channelId, name, mime, buf);
    if (!meta) { this.fail(res, 400, 'invalid'); return; }
    this.json(res, 200, meta);
  }

  // 다운로드: 저장된 mime이 화이트리스트 밖이면 application/octet-stream(브라우저 신뢰 금지).
  // 이미지만 inline(그 외=attachment) — Content-Disposition에 서버 내부 경로는 절대 노출하지 않는다
  // (파일명만, RFC5987 filename*=UTF-8'' 인코딩).
  private download(res: http.ServerResponse, channelId: string, id: string): void {
    const p = this.deps.attachments.path(channelId, id);
    if (!p) { this.fail(res, 404, 'not found'); return; }
    const meta = this.deps.attachments.meta(channelId, id);
    const mime = meta?.mime ?? 'application/octet-stream';
    const name = meta?.name ?? id;
    const outMime = MIME_WHITELIST.has(mime) ? mime : 'application/octet-stream';
    const disposition = IMAGE_MIME_WHITELIST.has(mime) ? 'inline' : 'attachment';
    // writeHead 실패(예: 헤더 값에 금지 문자) 시 상위 handle()의 try/catch가 500으로 흡수한다
    // (never-throw는 handle() 레벨에서 한 곳으로 모은다 — 여기서 개별 방어하지 않는다).
    res.writeHead(200, {
      'content-type': outMime,
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    const stream = fs.createReadStream(p);
    stream.on('error', () => { try { res.destroy(); } catch { /* 격리 */ } });
    stream.pipe(res);
  }
}
