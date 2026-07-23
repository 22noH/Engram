import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AccountStore } from '../auth/account-store';
import { SessionStore } from '../auth/session-store';
import { GroupStore } from '../auth/group-store';
import { ChatStore } from './chat-store';
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from './attachment-store';
import { AttachmentsHttp } from './attachments-http';
import * as mcpHttp from '../mcp/mcp-http';

describe('AttachmentsHttp(업로드/다운로드, Task 2)', () => {
  let dir: string;
  let server: http.Server;
  let base: string;
  let accounts: AccountStore;
  let sessions: SessionStore;
  let groups: GroupStore;
  let chat: ChatStore;
  let attachments: AttachmentStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ath-'));
    accounts = new AccountStore(dir);
    sessions = new SessionStore(dir);
    groups = new GroupStore(dir);
    chat = new ChatStore(path.join(dir, 'chat'));
    chat.listChannels(); // general 생성
    attachments = new AttachmentStore(path.join(dir, 'data'));
    const http_ = new AttachmentsHttp({ accounts, sessions, groups, chat, attachments });
    server = http.createServer((req, res) => {
      void http_.handle(req, res).then((hit) => { if (!hit) { res.writeHead(404); res.end(); } });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('/attachments/ 밖 경로는 false(404)', async () => {
    expect((await fetch(base + '/other')).status).toBe(404);
  });

  it('무인증 모드(계정 0개+루프백): 업로드→다운로드 바이트 동일(no-auth localFree)', async () => {
    const data = Buffer.from('hello world png bytes');
    const up = await fetch(base + '/attachments/general', {
      method: 'POST',
      headers: { 'content-type': 'image/png', 'x-attachment-name': encodeURIComponent('photo.png') },
      body: data,
    });
    expect(up.status).toBe(200);
    const meta = await up.json() as { id: string; name: string; mime: string; size: number };
    expect(meta.name).toBe('photo.png');
    expect(meta.mime).toBe('image/png');
    expect(meta.size).toBe(data.length);

    const down = await fetch(`${base}/attachments/general/${meta.id}`);
    expect(down.status).toBe(200);
    expect(down.headers.get('content-type')).toBe('image/png');
    expect(down.headers.get('content-disposition')).toContain('inline');
    expect(down.headers.get('content-disposition')).toContain("filename*=UTF-8''photo.png");
    const bytes = Buffer.from(await down.arrayBuffer());
    expect(bytes).toEqual(data); // 업로드→다운로드 바이트 동일
  });

  it('세션 필요 모드(계정 존재): 토큰 없이 업로드 → 401', async () => {
    accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
    const r = await fetch(base + '/attachments/general', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-attachment-name': 'a.txt' },
      body: 'hi',
    });
    expect(r.status).toBe(401);
  });

  it('세션 필요 모드: 유효 토큰 → 업로드/다운로드 통과', async () => {
    const acc = accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
    const token = sessions.issue(acc.id).token;
    const up = await fetch(base + '/attachments/general', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain', 'x-attachment-name': 'note.txt' },
      body: 'hello',
    });
    expect(up.status).toBe(200);
    const meta = await up.json() as { id: string };
    const down = await fetch(`${base}/attachments/general/${meta.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(down.status).toBe(200);
    expect(await down.text()).toBe('hello');
  });

  it('비공개 채널 비멤버 → 403', async () => {
    const owner = accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
    const outsider = accounts.createPassword('out', 'pw', 'Out', { status: 'active' });
    const ch = chat.createChannel('secret', 'chat', owner.id, 'private')!;
    const token = sessions.issue(outsider.id).token;
    const r = await fetch(`${base}/attachments/${ch.id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain', 'x-attachment-name': 'x.txt' },
      body: 'x',
    });
    expect(r.status).toBe(403);
  });

  it('비공개 채널 멤버(memberIds) → 통과', async () => {
    const owner = accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
    const member = accounts.createPassword('mem', 'pw', 'Mem', { status: 'active' });
    const ch = chat.createChannel('secret2', 'chat', owner.id, 'private')!;
    chat.setMembers(ch.id, [member.id]);
    const token = sessions.issue(member.id).token;
    const r = await fetch(`${base}/attachments/${ch.id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain', 'x-attachment-name': 'x.txt' },
      body: 'x',
    });
    expect(r.status).toBe(200);
  });

  it('계정 0개지만 비루프백이면 localFree 미적용 → 토큰 없이 401(무인증 우회 차단)', async () => {
    const spy = jest.spyOn(mcpHttp, 'isLoopback').mockReturnValue(false);
    try {
      const r = await fetch(base + '/attachments/general', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'x-attachment-name': 'x.txt' },
        body: 'x',
      });
      expect(r.status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  it('존재하지 않는 채널(세션 유효) → 404', async () => {
    const acc = accounts.createPassword('boss', 'pw', 'Boss', { role: 'owner', status: 'active' });
    const token = sessions.issue(acc.id).token;
    const r = await fetch(base + '/attachments/nope-channel', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain', 'x-attachment-name': 'x.txt' },
      body: 'x',
    });
    expect(r.status).toBe(404);
  });

  it('위조 id(uuid 형태 아님/미존재) → 다운로드 404', async () => {
    expect((await fetch(`${base}/attachments/general/not-a-uuid`)).status).toBe(404);
    expect((await fetch(`${base}/attachments/general/11111111-1111-1111-1111-111111111111`)).status).toBe(404);
  });

  it('경로 구멍 channelId(safeId 위반) → 400', async () => {
    // fetch/undici는 URL 정규화 단계에서 '..' 세그먼트를 보내기 전에 collapse해버려 서버에 리터럴
    // '..'가 도달하지 않는다(정상 클라이언트는 애초에 traversal을 못 만든다) — safeId 방어선을
    // 실제로 때리려면 raw http.request로 정규화를 우회해 request-target에 '..'를 그대로 실어 보낸다.
    const { port } = new URL(base);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/attachments/..', method: 'POST' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end('x');
    });
    expect(status).toBe(400);
  });

  it('20MB 초과 업로드 → 413(hang 없이 정착, 타임아웃 내 응답)', async () => {
    const oversize = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    const r = await fetch(base + '/attachments/general', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-attachment-name': 'big.bin' },
      body: oversize,
    });
    expect(r.status).toBe(413);
  }, 20000);

  it('x-attachment-name 미지정 → 파일명 폴백 file', async () => {
    const up = await fetch(base + '/attachments/general', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'no name header',
    });
    expect(up.status).toBe(200);
    const meta = await up.json() as { name: string };
    expect(meta.name).toBe('file');
  });

  it('화이트리스트 밖 mime(다운로드) → application/octet-stream + attachment 디스포지션', async () => {
    const up = await fetch(base + '/attachments/general', {
      method: 'POST',
      headers: { 'content-type': 'application/x-weird', 'x-attachment-name': 'weird.bin' },
      body: 'weird',
    });
    const meta = await up.json() as { id: string };
    const down = await fetch(`${base}/attachments/general/${meta.id}`);
    expect(down.headers.get('content-type')).toBe('application/octet-stream');
    expect(down.headers.get('content-disposition')).toContain('attachment');
    expect(down.headers.get('content-disposition')).not.toContain('inline');
  });

  it('text/plain은 화이트리스트 안이지만 disposition은 attachment(이미지만 inline)', async () => {
    const up = await fetch(base + '/attachments/general', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-attachment-name': 'note.txt' },
      body: 'plain text',
    });
    const meta = await up.json() as { id: string };
    const down = await fetch(`${base}/attachments/general/${meta.id}`);
    expect(down.headers.get('content-type')).toBe('text/plain');
    expect(down.headers.get('content-disposition')).toContain('attachment');
  });

  it('OPTIONS 프리플라이트 → 204 + CORS 헤더', async () => {
    const r = await fetch(base + '/attachments/general', { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-allow-headers')).toContain('x-attachment-name');
  });
});
