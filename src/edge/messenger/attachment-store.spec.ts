import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AttachmentStore } from './attachment-store';
import type { ChatMessage } from './chat-store';

describe('AttachmentStore', () => {
  let dir: string;
  let store: AttachmentStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-attach-'));
    store = new AttachmentStore(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('save 왕복 — 실파일이 생기고 path()/meta()로 조회된다(원본 확장자 보존)', () => {
    const data = Buffer.from('hello world');
    const meta = store.save('general', 'photo.png', 'image/png', data)!;
    expect(meta).toBeTruthy();
    expect(meta.name).toBe('photo.png');
    expect(meta.mime).toBe('image/png');
    expect(meta.size).toBe(data.length);
    expect(meta.id.endsWith('.png')).toBe(true);

    const p = store.path('general', meta.id)!;
    expect(p).toBeTruthy();
    expect(fs.readFileSync(p)).toEqual(data);
    expect(fs.existsSync(path.join(dir, 'attachments', 'general', `${meta.id}.json`))).toBe(true);

    expect(store.meta('general', meta.id)).toEqual(meta);
  });

  it('save — 확장자 없는 파일명도 저장되고 path 조회 가능', () => {
    const meta = store.save('general', 'README', 'text/plain', Buffer.from('x'))!;
    expect(meta.id.includes('.')).toBe(false);
    expect(store.path('general', meta.id)).toBeTruthy();
  });

  it('save — 20MB 초과는 null, 파일이 생성되지 않는다(상한 거부)', () => {
    const tooBig = Buffer.alloc(20 * 1024 * 1024 + 1);
    const meta = store.save('general', 'big.bin', 'application/octet-stream', tooBig);
    expect(meta).toBeNull();
    expect(fs.existsSync(path.join(dir, 'attachments', 'general'))).toBe(false);
  });

  it('save — 정확히 20MB는 허용(경계값)', () => {
    const exact = Buffer.alloc(20 * 1024 * 1024);
    const meta = store.save('general', 'exact.bin', 'application/octet-stream', exact);
    expect(meta).not.toBeNull();
  });

  it('save — 경로 구멍(..형) channelId는 거부', () => {
    expect(store.save('../evil', 'x.txt', 'text/plain', Buffer.from('x'))).toBeNull();
  });

  it('save — 빈 버퍼는 거부', () => {
    expect(store.save('general', 'empty.txt', 'text/plain', Buffer.alloc(0))).toBeNull();
  });

  it('path — 위조 id(uuid 형태 아님)는 null', () => {
    expect(store.path('general', 'not-a-uuid')).toBeNull();
    expect(store.path('general', '../../etc/passwd')).toBeNull();
  });

  it('path — uuid 형태지만 실재하지 않는 id는 null', () => {
    expect(store.path('general', '11111111-1111-1111-1111-111111111111')).toBeNull();
  });

  it('path — 경로 구멍 channelId는 null', () => {
    const meta = store.save('general', 'x.txt', 'text/plain', Buffer.from('x'))!;
    expect(store.path('../evil', meta.id)).toBeNull();
  });

  it('meta — 위조/미존재 id는 null', () => {
    expect(store.meta('general', 'not-a-uuid')).toBeNull();
    expect(store.meta('general', '11111111-1111-1111-1111-111111111111')).toBeNull();
  });

  it('deleteFor — 메시지 attachments의 실파일+메타를 지운다', () => {
    const a = store.save('general', 'a.txt', 'text/plain', Buffer.from('a'))!;
    const b = store.save('general', 'b.txt', 'text/plain', Buffer.from('b'))!;
    const msgs: ChatMessage[] = [
      { id: 'm1', authorId: 'u1', text: 'hi', ts: new Date().toISOString(), attachments: [a] },
      { id: 'm2', authorId: 'u1', text: 'hi2', ts: new Date().toISOString(), attachments: [b] },
    ];
    store.deleteFor(msgs);
    expect(store.path('general', a.id)).toBeNull();
    expect(store.path('general', b.id)).toBeNull();
    expect(fs.existsSync(path.join(dir, 'attachments', 'general', `${a.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'attachments', 'general', `${b.id}.json`))).toBe(false);
  });

  it('deleteFor — attachments 없는 메시지/빈 배열은 무해(never-throw)', () => {
    const noAttach: ChatMessage = { id: 'm1', authorId: 'u1', text: 'hi', ts: new Date().toISOString() };
    expect(() => store.deleteFor([noAttach])).not.toThrow();
    expect(() => store.deleteFor([])).not.toThrow();
  });

  it('deleteFor — attachments/ 디렉터리 자체가 없어도 무해', () => {
    const fresh = new AttachmentStore(fs.mkdtempSync(path.join(os.tmpdir(), 'engram-attach-empty-')));
    const msg: ChatMessage = {
      id: 'm1',
      authorId: 'u1',
      text: 'hi',
      ts: new Date().toISOString(),
      attachments: [{ id: '11111111-1111-1111-1111-111111111111', name: 'x', mime: 'text/plain', size: 1 }],
    };
    expect(() => fresh.deleteFor([msg])).not.toThrow();
  });

  it('deleteFor — 지워지지 않은 다른 채널/다른 메시지의 첨부는 그대로 남는다', () => {
    const keep = store.save('general', 'keep.txt', 'text/plain', Buffer.from('keep'))!;
    const drop = store.save('dev', 'drop.txt', 'text/plain', Buffer.from('drop'))!;
    const msg: ChatMessage = {
      id: 'm1',
      authorId: 'u1',
      text: 'hi',
      ts: new Date().toISOString(),
      attachments: [drop],
    };
    store.deleteFor([msg]);
    expect(store.path('dev', drop.id)).toBeNull();
    expect(store.path('general', keep.id)).toBeTruthy(); // 다른 첨부는 무관하게 보존
  });

  it('여러 채널에 걸쳐 저장해도 각각 독립적으로 조회/삭제된다', () => {
    const g = store.save('general', 'g.txt', 'text/plain', Buffer.from('g'))!;
    const d = store.save('dev', 'd.txt', 'text/plain', Buffer.from('d'))!;
    expect(store.path('general', g.id)).toBeTruthy();
    expect(store.path('dev', d.id)).toBeTruthy();
    // general 폴더에서 dev의 id로 조회하면 없음(채널 분리 확인).
    expect(store.path('general', d.id)).toBeNull();
  });
});
