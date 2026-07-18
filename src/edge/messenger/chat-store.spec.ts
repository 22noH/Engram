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
    expect(chs[0]).toMatchObject({ id: 'general', name: 'general', respondMode: 'all', mode: 'chat' });
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

  it('authorName이 넘어오면 저장되고, 없으면 필드 자체가 없다', () => {
    store.listChannels();
    const m = store.appendMessage('general', { authorId: 'u1', authorName: 'Kim', text: 'hi' })!;
    expect(m.authorName).toBe('Kim');
    const m2 = store.appendMessage('general', { authorId: 'owner', text: 'hi2' })!;
    expect('authorName' in m2).toBe(false);
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
    expect(chs).toEqual([{ id: 'x', name: 'x', respondMode: 'all', mode: 'chat' }]);
  });

  it('유효하지 않은 respondMode로 setRespondMode 호출 시 false', () => {
    store.listChannels(); // general 생성
    expect(store.setRespondMode('general', 'weird' as any)).toBe(false);
  });

  it('createChannel이 mode를 저장하고 listChannels가 정규화한다', () => {
    const code = store.createChannel('build-app', 'code');
    const chat = store.createChannel('talk'); // 기본 chat
    expect(code?.mode).toBe('code');
    const list = store.listChannels();
    expect(list.find((c) => c.id === code!.id)?.mode).toBe('code');
    expect(list.find((c) => c.id === chat!.id)?.mode).toBe('chat');
  });

  it('setRepoPath가 채널에 경로를 바인딩한다', () => {
    const ch = store.createChannel('c', 'code')!;
    expect(store.setRepoPath(ch.id, 'C:/repo/x')).toBe(true);
    expect(store.listChannels().find((c) => c.id === ch.id)?.repoPath).toBe('C:/repo/x');
    expect(store.setRepoPath('nope', 'C:/y')).toBe(false);
  });

  it('mode 필드가 오염돼도 chat으로 강등한다', () => {
    fs.writeFileSync(path.join(dir, 'channels.json'),
      JSON.stringify([{ id: 'a', name: 'a', respondMode: 'all', mode: 'bogus' }]));
    const fresh = new ChatStore(dir);
    expect(fresh.listChannels().find((c) => c.id === 'a')?.mode).toBe('chat');
  });

  it('appendMessage가 actions를 저장하고 history에 실어준다', () => {
    store.listChannels(); // general 채널 생성
    const acts = [{ label: '✅ 승인', send: '승인', confirm: '시작할까요?' }, { label: '취소', send: '취소' }];
    const m = store.appendMessage('general', { authorId: 'engram', text: '완성조건…', actions: acts });
    expect(m?.actions).toEqual(acts);
    expect(store.history('general').at(-1)?.actions).toEqual(acts);
  });

  it('createChannel이 team 모드를 저장하고 정규화가 team을 인정한다', () => {
    const t = store.createChannel('people', 'team');
    expect(t?.mode).toBe('team');
    expect(store.listChannels().find((c) => c.id === t!.id)?.mode).toBe('team');
  });
});

describe('ChatStore.createChannel creatorId (Phase 16b)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chc-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('creatorId 전달 시 채널에 기록', () => {
    const s = new ChatStore(dir);
    const ch = s.createChannel('general', 'chat', 'user-1');
    expect(ch?.creatorId).toBe('user-1');
    expect(s.listChannels().find((c) => c.id === ch!.id)?.creatorId).toBe('user-1');
  });

  it('creatorId 없으면 미기록(기존 동작)', () => {
    const s = new ChatStore(dir);
    const ch = s.createChannel('general', 'chat');
    expect(ch?.creatorId).toBeUndefined();
  });
});

describe('ChatStore 비공개 채널 (Phase 16c)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chpv-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('createChannel visibility=private 기록', () => {
    const s = new ChatStore(dir);
    const ch = s.createChannel('secret', 'chat', 'u1', 'private');
    expect(ch?.visibility).toBe('private');
    expect(s.listChannels().find((c) => c.id === ch!.id)?.visibility).toBe('private');
  });

  it('visibility 미전달·public이면 미기록(기존 동작)', () => {
    const s = new ChatStore(dir);
    expect(s.createChannel('a', 'chat', 'u1')?.visibility).toBeUndefined();
    expect(s.createChannel('b', 'chat', 'u1', 'public')?.visibility).toBeUndefined();
  });

  it('setVisibility·setMembers 영속, 없는 id는 false', () => {
    const s = new ChatStore(dir);
    const ch = s.createChannel('secret', 'chat', 'u1', 'private')!;
    expect(s.setMembers(ch.id, ['u2', 'u3'])).toBe(true);
    expect(s.setVisibility(ch.id, 'public')).toBe(true);
    const re = new ChatStore(dir).listChannels().find((c) => c.id === ch.id)!;
    expect(re.memberIds).toEqual(['u2', 'u3']);
    expect(re.visibility).toBeUndefined();
    expect(s.setMembers('없음', ['x'])).toBe(false);
    expect(s.setVisibility('없음', 'private')).toBe(false);
  });
});

describe('ChatStore.setChannelBrain (Task 1)', () => {
  let dir: string;
  let store: ChatStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-brain-'));
    store = new ChatStore(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('setChannelBrain 설정→영속 재로드에 남음', () => {
    const ch = store.createChannel('ai-dev')!;
    expect(store.setChannelBrain(ch.id, 'claude-opus')).toBe(true);
    const again = new ChatStore(dir);
    expect(again.listChannels().find((c) => c.id === ch.id)?.brain).toBe('claude-opus');
  });

  it('setChannelBrain null 해제→필드 자체 삭제', () => {
    const ch = store.createChannel('ai-dev')!;
    store.setChannelBrain(ch.id, 'claude-opus');
    expect(store.setChannelBrain(ch.id, null)).toBe(true);
    const again = new ChatStore(dir);
    expect(again.listChannels().find((c) => c.id === ch.id)?.brain).toBeUndefined();
  });

  it('없는 채널 id는 false', () => {
    expect(store.setChannelBrain('nonexistent', 'claude-opus')).toBe(false);
  });

  it('empty string 입력은 false 반환, 미변경', () => {
    const ch = store.createChannel('ai-dev')!;
    store.setChannelBrain(ch.id, 'claude-opus');
    expect(store.setChannelBrain(ch.id, '')).toBe(false);
    expect(store.listChannels().find((c) => c.id === ch.id)?.brain).toBe('claude-opus');
  });

  it('로드 정규화: brain이 비문자열/빈문자열이면 드롭', () => {
    fs.writeFileSync(
      path.join(dir, 'channels.json'),
      JSON.stringify([
        { id: 'a', name: 'a', respondMode: 'all', brain: 123 },
        { id: 'b', name: 'b', respondMode: 'all', brain: '' },
        { id: 'c', name: 'c', respondMode: 'all', brain: 'valid-brain' },
      ])
    );
    const fresh = new ChatStore(dir);
    const chs = fresh.listChannels();
    expect(chs.find((c) => c.id === 'a')?.brain).toBeUndefined();
    expect(chs.find((c) => c.id === 'b')?.brain).toBeUndefined();
    expect(chs.find((c) => c.id === 'c')?.brain).toBe('valid-brain');
  });

  it('기존 채널 데이터(brain 없음) 로드 무변경', () => {
    fs.writeFileSync(
      path.join(dir, 'channels.json'),
      JSON.stringify([{ id: 'general', name: 'general', respondMode: 'all' }])
    );
    const fresh = new ChatStore(dir);
    const ch = fresh.listChannels()[0];
    expect(ch.brain).toBeUndefined();
  });

  it('setChannelBrain 공백이 있는 값은 trim하여 저장', () => {
    const ch = store.createChannel('ai-dev')!;
    expect(store.setChannelBrain(ch.id, ' qwen ')).toBe(true);
    const again = new ChatStore(dir);
    expect(again.listChannels().find((c) => c.id === ch.id)?.brain).toBe('qwen');
  });
});
