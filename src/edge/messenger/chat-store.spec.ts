import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatStore } from './chat-store';

describe('ChatStore', () => {
  let dir: string;
  let store: ChatStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-chat-'));
    store = new ChatStore(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('첫 조회 시 general 채널이 자동 생성된다', () => {
    const chs = store.listChannels();
    expect(chs).toHaveLength(1);
    expect(chs[0]).toMatchObject({ id: 'general', name: 'general', respondMode: 'all' });
  });

  it('채널 생성/삭제/respondMode 변경이 지속된다', () => {
    const ch = store.createChannel('dev')!;
    expect(ch.respondMode).toBe('all');
    expect(store.setRespondMode(ch.id, 'mention')).toBe(true);
    const again = new ChatStore(dir); // 재열기로 로드 확인
    expect(again.listChannels().find((c) => c.id === ch.id)?.respondMode).toBe('mention');
    expect(again.deleteChannel(ch.id)).toBe(true);
    expect(again.has(ch.id)).toBe(false);
  });

  it('빈문자 채널은 만들지 못한다', () => {
    expect(store.createChannel('  ')).toBeNull();
  });

  it('메시지 append와 history 작동, id/ts 자동 부여', () => {
    store.listChannels(); // general 생성
    const m = store.appendMessage('general', { authorId: 'owner', text: '안녕' })!;
    expect(m.id).toBeTruthy();
    expect(m.ts).toBeTruthy();
    const h = store.history('general');
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ authorId: 'owner', text: '안녕' });
  });

  it('threadId가 보존된다', () => {
    store.listChannels();
    const anchor = store.appendMessage('general', { authorId: 'owner', text: 'q' })!;
    store.appendMessage('general', { authorId: 'engram', text: 'a', threadId: anchor.id });
    expect(store.history('general')[1].threadId).toBe(anchor.id);
  });

  it('없는 채널 append는 null, history는 빈배열', () => {
    expect(store.appendMessage('nope', { authorId: 'owner', text: 'x' })).toBeNull();
    expect(store.history('nope')).toEqual([]);
  });

  it('경로 구멍(..형) 채널 id는 거부된다(안전 검증)', () => {
    expect(store.appendMessage('../evil', { authorId: 'owner', text: 'x' })).toBeNull();
    expect(store.history('..\\evil')).toEqual([]);
  });

  it('손상 줄은 스킵된다', () => {
    store.listChannels();
    store.appendMessage('general', { authorId: 'owner', text: 'ok' });
    fs.appendFileSync(path.join(dir, 'general.jsonl'), '{broken\n');
    store.appendMessage('general', { authorId: 'owner', text: 'ok2' });
    expect(store.history('general').map((m) => m.text)).toEqual(['ok', 'ok2']);
  });

  it('history limit과 before 필터작동', () => {
    store.listChannels();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(store.appendMessage('general', { authorId: 'owner', text: `m${i}` })!.id);
    expect(store.history('general', { limit: 2 }).map((m) => m.text)).toEqual(['m3', 'm4']);
    expect(store.history('general', { limit: 2, before: ids[3] }).map((m) => m.text)).toEqual(['m1', 'm2']);
  });

  it('손수정된 channels.json의 유효하지않은 respondMode는 all로 정규화된다', () => {
    fs.writeFileSync(path.join(dir, 'channels.json'), JSON.stringify([{ id: 'x', name: 'x', respondMode: 'xyz' }]));
    const chs = store.listChannels();
    expect(chs).toEqual([{ id: 'x', name: 'x', respondMode: 'all' }]);
  });

  it('유효하지 않은 respondMode로 setRespondMode 호출 시 false', () => {
    store.listChannels(); // general 생성
    expect(store.setRespondMode('general', 'weird' as any)).toBe(false);
  });
});
