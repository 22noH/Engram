import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatStore, ChatMessage } from './chat-store';

// 매크로태스크 경계까지 마이크로태스크를 흘려보낸다(fire-and-forget runAutoCompact 완료 대기용).
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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

// Minor 1(최종 리뷰): listChannels 정규화는 필드 화이트리스트라 ChatChannel에 필드를 늘리고 여기
// 손대지 않으면 조용히 소실된다 — 전 필드가 채워진 채널이 listChannels→save→listChannels를
// 왕복해도 그대로 남는지 지키는 가드.
describe('ChatStore listChannels 정규화 왕복(Minor 1 가드)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-roundtrip-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('모든 필드가 채워진 채널이 왕복(listChannels→save→listChannels) 후에도 그대로', () => {
    const full = {
      id: 'full-ch',
      name: 'Full Channel',
      respondMode: 'mention' as const,
      mode: 'code' as const,
      repoPath: 'C:/repo/full',
      creatorId: 'user-1',
      ownerId: 'owner-1',
      visibility: 'private' as const,
      memberIds: ['user-1', 'user-2'],
      brain: 'claude-opus',
    };
    fs.writeFileSync(path.join(dir, 'channels.json'), JSON.stringify([full]));
    const store = new ChatStore(dir);
    expect(store.listChannels().find((c) => c.id === 'full-ch')).toEqual(full);
    // setRespondMode('mention')은 값이 이미 mention이라 실질 변경은 없지만 내부적으로
    // listChannels()(정규화)→save(list)를 거쳐 다시 디스크에 쓴다 — 이게 왕복 지점.
    expect(store.setRespondMode('full-ch', 'mention')).toBe(true);
    const reloaded = new ChatStore(dir).listChannels().find((c) => c.id === 'full-ch');
    expect(reloaded).toEqual(full);
  });
});

describe('ChatStore 대화 보존 정책(Task 1: S4)', () => {
  let dir: string;
  let store: ChatStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-retention-'));
    store = new ChatStore(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('기본 정책은 unlimited — 프루닝 없음(회귀)', () => {
    store.listChannels();
    for (let i = 0; i < 5; i++) store.appendMessage('general', { authorId: 'owner', text: `m${i}` });
    expect(store.history('general', { limit: 100 })).toHaveLength(5);
    const raw = fs.readFileSync(path.join(dir, 'general.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(raw).toHaveLength(5);
  });

  it('count=3 정책 — 5개 append 후 마지막 3개만 남고 재로드에도 유지', () => {
    store.setRetention({ mode: 'count', value: 3 });
    store.listChannels();
    for (let i = 0; i < 5; i++) store.appendMessage('general', { authorId: 'owner', text: `m${i}` });
    expect(store.history('general').map((m) => m.text)).toEqual(['m2', 'm3', 'm4']);
    // 재로드(새 인스턴스, 기본 unlimited)해도 파일 자체가 이미 잘렸으므로 그대로 유지.
    const again = new ChatStore(dir);
    expect(again.history('general').map((m) => m.text)).toEqual(['m2', 'm3', 'm4']);
  });

  it('count 값이 0/음수/정수아님이면 no-op', () => {
    store.listChannels();
    for (const bad of [0, -1, 1.5]) {
      store.setRetention({ mode: 'count', value: bad });
      store.appendMessage('general', { authorId: 'owner', text: 'x' });
    }
    expect(store.history('general')).toHaveLength(3); // 3번 append, 프루닝 전혀 안 됨
  });

  it('count 정책인데 value 미지정이면 no-op', () => {
    store.listChannels();
    store.setRetention({ mode: 'count' });
    store.appendMessage('general', { authorId: 'owner', text: 'a' });
    store.appendMessage('general', { authorId: 'owner', text: 'b' });
    expect(store.history('general')).toHaveLength(2);
  });

  it('days=1 정책 — 오래된 ts 줄 제거, 최근 유지', () => {
    store.listChannels();
    const oldTs = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const recentTs = new Date().toISOString();
    const oldMsg = { id: 'old-1', authorId: 'owner', text: 'old', ts: oldTs };
    const recentMsg = { id: 'recent-1', authorId: 'owner', text: 'recent', ts: recentTs };
    fs.appendFileSync(
      path.join(dir, 'general.jsonl'),
      JSON.stringify(oldMsg) + '\n' + JSON.stringify(recentMsg) + '\n',
    );
    store.setRetention({ mode: 'days', value: 1 });
    store.pruneChannel('general');
    expect(store.history('general').map((m) => m.id)).toEqual(['recent-1']);
  });

  it('days 정책 — ts 파싱 불가/손상 줄은 안전하게 보존(드롭 금지)', () => {
    store.listChannels();
    const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const badTsMsg = { id: 'bad-ts', authorId: 'owner', text: 'bad', ts: 'not-a-date' };
    const oldMsg = { id: 'old-1', authorId: 'owner', text: 'old', ts: oldTs };
    fs.appendFileSync(
      path.join(dir, 'general.jsonl'),
      JSON.stringify(oldMsg) + '\n' + JSON.stringify(badTsMsg) + '\n' + '{broken json\n',
    );
    store.setRetention({ mode: 'days', value: 1 });
    expect(() => store.pruneChannel('general')).not.toThrow();
    const raw = fs.readFileSync(path.join(dir, 'general.jsonl'), 'utf8').split('\n').filter(Boolean);
    // old-1(만료)은 제거, ts 파싱 불가(bad-ts)와 완전 손상 줄은 안전하게 보존.
    expect(raw).toHaveLength(2);
    expect(raw.some((l) => l.includes('bad-ts'))).toBe(true);
    expect(raw.some((l) => l.includes('broken json'))).toBe(true);
  });

  it('손상 줄이 있어도 count 프루닝은 안전(never-throw)', () => {
    store.listChannels();
    store.appendMessage('general', { authorId: 'owner', text: 'ok1' });
    fs.appendFileSync(path.join(dir, 'general.jsonl'), '{broken\n');
    store.setRetention({ mode: 'count', value: 1 });
    expect(() => store.appendMessage('general', { authorId: 'owner', text: 'ok2' })).not.toThrow();
    expect(store.history('general').map((m) => m.text)).toEqual(['ok2']);
  });

  it('pruneChannel을 없는 채널/파일 없는 채널에 호출해도 무해', () => {
    expect(() => store.pruneChannel('no-such-channel')).not.toThrow();
    store.listChannels();
    store.setRetention({ mode: 'count', value: 3 });
    expect(() => store.pruneChannel('general')).not.toThrow(); // 아직 append 없어 파일 없음
  });

  it('setRetention에 잘못된 mode를 주면 unlimited로 강등', () => {
    store.setRetention({ mode: 'bogus' as any, value: 1 });
    store.listChannels();
    for (let i = 0; i < 5; i++) store.appendMessage('general', { authorId: 'owner', text: `m${i}` });
    expect(store.history('general')).toHaveLength(5);
  });

  it('생성자에 정책을 주입할 수 있다(하위호환: 인자 없어도 기본 unlimited)', () => {
    const withPolicy = new ChatStore(dir, { mode: 'count', value: 2 });
    withPolicy.listChannels();
    for (let i = 0; i < 4; i++) withPolicy.appendMessage('general', { authorId: 'owner', text: `m${i}` });
    expect(withPolicy.history('general').map((m) => m.text)).toEqual(['m2', 'm3']);
  });

  it('historyBytes — 빈 디렉터리 0, append 후 실제 파일 크기 합산과 일치', () => {
    expect(store.historyBytes()).toBe(0);
    store.listChannels();
    store.appendMessage('general', { authorId: 'owner', text: 'hello' });
    const ch2 = store.createChannel('dev')!;
    store.appendMessage(ch2.id, { authorId: 'owner', text: 'world' });
    const expected =
      fs.statSync(path.join(dir, 'general.jsonl')).size + fs.statSync(path.join(dir, `${ch2.id}.jsonl`)).size;
    expect(store.historyBytes()).toBe(expected);
  });

  it('historyBytes — chatDir 자체가 없으면 0(무해)', () => {
    const missing = new ChatStore(path.join(dir, 'does-not-exist'));
    expect(missing.historyBytes()).toBe(0);
  });
});

describe('ChatStore clearChannel/undoClear/dropClearBackup(Task 1: clear/compact)', () => {
  let dir: string;
  let store: ChatStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-clear-'));
    store = new ChatStore(dir);
    store.listChannels(); // general 채널 생성
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function jsonlPath(id = 'general'): string { return path.join(dir, `${id}.jsonl`); }
  function clearedPath(id = 'general'): string { return `${jsonlPath(id)}.cleared`; }

  it('clearChannel — jsonl이 .cleared로 rename되고 history는 빈배열', () => {
    for (let i = 0; i < 3; i++) store.appendMessage('general', { authorId: 'owner', text: `m${i}` });
    store.clearChannel('general');
    expect(fs.existsSync(jsonlPath())).toBe(false);
    expect(fs.existsSync(clearedPath())).toBe(true);
    expect(store.history('general')).toEqual([]);
  });

  it('undoClear — clear 후 되돌리면 history가 원복되고 백업은 사라짐', () => {
    for (let i = 0; i < 3; i++) store.appendMessage('general', { authorId: 'owner', text: `m${i}` });
    store.clearChannel('general');
    expect(store.undoClear('general')).toBe(true);
    expect(store.history('general').map((m) => m.text)).toEqual(['m0', 'm1', 'm2']);
    expect(fs.existsSync(clearedPath())).toBe(false);
  });

  it('undoClear — 백업이 없으면 false', () => {
    expect(store.undoClear('general')).toBe(false);
  });

  it('clear 두 번 — 첫 백업은 지워지고 두 번째 것만 남음(백업 1개 유지)', () => {
    store.appendMessage('general', { authorId: 'owner', text: 'first' });
    store.clearChannel('general');
    const firstBackupContent = fs.readFileSync(clearedPath(), 'utf8');
    expect(firstBackupContent).toContain('first');

    store.appendMessage('general', { authorId: 'owner', text: 'second' });
    store.clearChannel('general');
    const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.cleared'));
    expect(entries).toHaveLength(1);
    const secondBackupContent = fs.readFileSync(clearedPath(), 'utf8');
    expect(secondBackupContent).toContain('second');
    expect(secondBackupContent).not.toContain('first');
  });

  it('dropClearBackup — 백업 제거 후 undoClear는 false', () => {
    store.appendMessage('general', { authorId: 'owner', text: 'x' });
    store.clearChannel('general');
    store.dropClearBackup('general');
    expect(fs.existsSync(clearedPath())).toBe(false);
    expect(store.undoClear('general')).toBe(false);
  });

  it('dropClearBackup — 백업 없어도 무해(never-throw)', () => {
    expect(() => store.dropClearBackup('general')).not.toThrow();
  });

  it('clear 후 새 메시지가 쌓이면(새 jsonl 생성) undoClear는 덮어쓰지 않고 false', () => {
    store.appendMessage('general', { authorId: 'owner', text: 'old' });
    store.clearChannel('general');
    store.appendMessage('general', { authorId: 'owner', text: 'new' });
    expect(store.undoClear('general')).toBe(false);
    // 덮어쓰지 않았으므로 새 메시지와 백업 둘 다 그대로.
    expect(store.history('general').map((m) => m.text)).toEqual(['new']);
    expect(fs.existsSync(clearedPath())).toBe(true);
  });

  it('없는 채널/파일 없는 채널에 clearChannel·undoClear·dropClearBackup 호출해도 무해', () => {
    expect(() => store.clearChannel('no-such-channel')).not.toThrow();
    expect(() => store.undoClear('no-such-channel')).not.toThrow();
    expect(() => store.dropClearBackup('no-such-channel')).not.toThrow();
    expect(store.undoClear('no-such-channel')).toBe(false);
  });

  it('빈 채널(메시지 0개)에 clearChannel — jsonl이 아예 없으므로 no-op, .cleared도 없음', () => {
    store.clearChannel('general');
    expect(fs.existsSync(clearedPath())).toBe(false);
    expect(store.history('general')).toEqual([]);
  });

  it('손상된 jsonl도 clearChannel/undoClear가 안전하게 rename(내용 검사 없이 통째로 이동)', () => {
    fs.appendFileSync(jsonlPath(), '{broken json\n');
    expect(() => store.clearChannel('general')).not.toThrow();
    expect(fs.existsSync(clearedPath())).toBe(true);
    expect(() => store.undoClear('general')).not.toThrow();
    expect(fs.existsSync(jsonlPath())).toBe(true);
    // ★내용 보존 실증(리뷰 지적): rename은 바이트를 그대로 옮기므로 파싱 불가한 원문도 살아 있어야 한다
    // — 존재만이 아니라 내용까지 왕복 보존됨을 단언(undo가 재직렬화로 손상 줄을 흘리는 회귀 차단).
    expect(fs.readFileSync(jsonlPath(), 'utf8')).toContain('{broken json');
  });

  it('never-throw — rename/unlink가 실제로 실패해도 삼키고 대화를 잃지 않는다', () => {
    // 리뷰 지적: outer try/catch의 '로그 후 계속' swallow 분기가 테스트로 한 번도 안 밟혔다(임시 dir이 늘
    // 성공). fs 모킹은 이 환경에서 non-configurable이라 불가 → .cleared 경로에 "비어있지 않은 디렉터리"를
    // 두어 rename/unlink가 실제 EPERM/ENOTEMPTY로 던지게 만들어 크로스플랫폼으로 swallow를 실증한다.

    // ① clearChannel: 백업 경로가 비어있지 않은 디렉터리 → unlink·rename 모두 실제 실패 → 삼키고 대화 보존
    store.appendMessage('general', { authorId: 'owner', text: 'x' });
    fs.mkdirSync(clearedPath());
    fs.writeFileSync(path.join(clearedPath(), 'blocker'), 'x'); // 비어있지 않아 rename 대상이 될 수 없음
    expect(() => store.clearChannel('general')).not.toThrow();
    expect(fs.existsSync(jsonlPath())).toBe(true); // rename 실패 = 대화 유실 없이 그대로
    expect(store.history('general').map((m) => m.text)).toEqual(['x']);

    // ② dropClearBackup: 같은 상태(백업이 비어있지 않은 디렉터리) → unlink 실제 실패 → 삼킴
    expect(() => store.dropClearBackup('general')).not.toThrow();
  });

  it('safeId가 아닌 id(경로 구멍)는 무해하게 no-op', () => {
    expect(() => store.clearChannel('../evil')).not.toThrow();
    expect(() => store.dropClearBackup('..\\evil')).not.toThrow();
    expect(store.undoClear('../evil')).toBe(false);
  });

  it('부팅 정리 — 이전 세션의 잔여 .cleared 백업은 새 ChatStore 생성 시 제거된다', () => {
    store.appendMessage('general', { authorId: 'owner', text: 'x' });
    store.clearChannel('general');
    expect(fs.existsSync(clearedPath())).toBe(true);
    const reopened = new ChatStore(dir); // 새 세션(재부팅) 시뮬레이션
    expect(fs.existsSync(clearedPath())).toBe(false);
    expect(reopened.undoClear('general')).toBe(false);
  });
});

describe('ChatStore removeMessagesByIds(Task 5: clear-compact 자동 compact)', () => {
  let dir: string;
  let store: ChatStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-removeids-'));
    store = new ChatStore(dir);
    store.listChannels();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('주어진 id들만 정확히 제거하고 나머지는 순서 그대로 보존', () => {
    const ids = [0, 1, 2, 3].map((i) => store.appendMessage('general', { authorId: 'owner', text: `m${i}` })!.id);
    store.removeMessagesByIds('general', new Set([ids[0], ids[2]]));
    expect(store.history('general').map((m) => m.text)).toEqual(['m1', 'm3']);
  });

  it('빈 id 집합은 no-op', () => {
    store.appendMessage('general', { authorId: 'owner', text: 'a' });
    store.removeMessagesByIds('general', new Set());
    expect(store.history('general')).toHaveLength(1);
  });

  it('존재하지 않는 id는 무해(아무것도 안 지워짐)', () => {
    store.appendMessage('general', { authorId: 'owner', text: 'a' });
    expect(() => store.removeMessagesByIds('general', new Set(['no-such-id']))).not.toThrow();
    expect(store.history('general')).toHaveLength(1);
  });

  it('없는 채널/파일 없는 채널/safeId 아닌 id는 무해', () => {
    expect(() => store.removeMessagesByIds('no-such-channel', new Set(['x']))).not.toThrow();
    expect(() => store.removeMessagesByIds('../evil', new Set(['x']))).not.toThrow();
  });

  it('손상 줄은 안전하게 보존(드롭 금지)', () => {
    const id = store.appendMessage('general', { authorId: 'owner', text: 'ok' })!.id;
    fs.appendFileSync(path.join(dir, 'general.jsonl'), '{broken\n');
    store.removeMessagesByIds('general', new Set([id]));
    const raw = fs.readFileSync(path.join(dir, 'general.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(raw).toHaveLength(1);
    expect(raw[0]).toContain('broken');
  });

  it('재로드 후에도 제거 결과가 유지된다', () => {
    const ids = [0, 1].map((i) => store.appendMessage('general', { authorId: 'owner', text: `m${i}` })!.id);
    store.removeMessagesByIds('general', new Set([ids[0]]));
    const again = new ChatStore(dir);
    expect(again.history('general').map((m) => m.text)).toEqual(['m1']);
  });
});

describe('ChatStore 자동 compact 훅(Task 5: clear-compact)', () => {
  let dir: string;
  let store: ChatStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-autocompact-'));
    store = new ChatStore(dir, { mode: 'count', value: 2 });
    store.listChannels();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('훅 미주입 — 기존 동기 프루닝 그대로(회귀 0)', () => {
    for (let i = 0; i < 3; i++) store.appendMessage('general', { authorId: 'owner', text: `m${i}` });
    expect(store.history('general').map((m) => m.text)).toEqual(['m1', 'm2']);
  });

  it('훅 주입 + count=2 + 3개 append — 가장 오래된(dropped) 메시지로 훅이 호출되고, 성공(true) 후에만 제거된다', async () => {
    const calls: Array<{ channelId: string; dropped: ChatMessage[] }> = [];
    store.setAutoCompactHook(async (channelId, dropped) => {
      calls.push({ channelId, dropped });
      return true;
    });
    store.appendMessage('general', { authorId: 'owner', text: 'm0' });
    store.appendMessage('general', { authorId: 'owner', text: 'm1' });
    // 세 번째 append 시점에 kept=[m1,m2]·dropped=[m0] — 프루닝 전 파일엔 아직 m0가 남아있어야 한다(동기
    // 삭제를 우회했다는 증거). 훅이 아직 비동기로 진행 중일 수 있으므로 append 직후 즉시 확인.
    store.appendMessage('general', { authorId: 'owner', text: 'm2' });

    expect(calls).toHaveLength(1);
    expect(calls[0].channelId).toBe('general');
    expect(calls[0].dropped.map((m) => m.text)).toEqual(['m0']);

    await flush();
    expect(store.history('general').map((m) => m.text)).toEqual(['m1', 'm2']);
    // 파일 자체에서도 정확히 그 메시지만 사라졌는지(정밀 제거) 확인.
    const raw = fs.readFileSync(path.join(dir, 'general.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(raw).toHaveLength(2);
  });

  it('훅이 false를 반환하면(요약/위키 저장 실패) 아무것도 지워지지 않는다', async () => {
    store.setAutoCompactHook(async () => false);
    store.appendMessage('general', { authorId: 'owner', text: 'm0' });
    store.appendMessage('general', { authorId: 'owner', text: 'm1' });
    store.appendMessage('general', { authorId: 'owner', text: 'm2' });

    await flush();
    // 실패했으므로 3개 전부 남아있어야 함(never-throw·안전 우선).
    expect(store.history('general', { limit: 10 }).map((m) => m.text)).toEqual(['m0', 'm1', 'm2']);
  });

  it('훅이 reject해도(never-throw) 프로세스가 죽지 않고, 아무것도 지워지지 않는다', async () => {
    store.setAutoCompactHook(async () => { throw new Error('brain down'); });
    expect(() => {
      store.appendMessage('general', { authorId: 'owner', text: 'm0' });
      store.appendMessage('general', { authorId: 'owner', text: 'm1' });
      store.appendMessage('general', { authorId: 'owner', text: 'm2' });
    }).not.toThrow();

    await flush();
    expect(store.history('general', { limit: 10 }).map((m) => m.text)).toEqual(['m0', 'm1', 'm2']);
  });

  it('unlimited 정책 — 훅이 주입돼도 호출되지 않는다(프루닝 자체가 없음)', async () => {
    const unlimited = new ChatStore(dir);
    unlimited.listChannels();
    const hook = jest.fn(async () => true);
    unlimited.setAutoCompactHook(hook);
    for (let i = 0; i < 5; i++) unlimited.appendMessage('general', { authorId: 'owner', text: `x${i}` });
    await flush();
    expect(hook).not.toHaveBeenCalled();
    expect(unlimited.history('general', { limit: 10 })).toHaveLength(5);
  });

  it('디바운스 — 훅 진행 중에 겹치는 append는 새 라운드를 건너뛰고, 완료 후 다음 append에서 재시도된다', async () => {
    let resolveHook!: (v: boolean) => void;
    const hookCalls: ChatMessage[][] = [];
    store.setAutoCompactHook((_channelId, dropped) => {
      hookCalls.push(dropped);
      return new Promise<boolean>((res) => { resolveHook = res; });
    });

    store.appendMessage('general', { authorId: 'owner', text: 'm0' });
    store.appendMessage('general', { authorId: 'owner', text: 'm1' });
    store.appendMessage('general', { authorId: 'owner', text: 'm2' }); // 훅 호출 시작(pending), dropped=[m0]
    expect(hookCalls).toHaveLength(1);

    // 훅이 아직 안 끝났는데 겹쳐서 append — 디바운스로 이번 라운드는 훅을 다시 부르지 않아야 함.
    store.appendMessage('general', { authorId: 'owner', text: 'm3' });
    expect(hookCalls).toHaveLength(1); // 여전히 1회(디바운스로 스킵)

    resolveHook(true);
    await flush();
    // 첫 훅 성공 → m0만 제거. 파일엔 m1,m2,m3 남음(동기 프루닝이 스킵됐으므로 count=2 초과 상태 그대로).
    expect(store.history('general', { limit: 10 }).map((m) => m.text)).toEqual(['m1', 'm2', 'm3']);

    // 다음 append가 다시 프루닝을 트리거 — 이번엔 in-flight가 아니므로 훅이 재호출된다.
    store.appendMessage('general', { authorId: 'owner', text: 'm4' });
    expect(hookCalls).toHaveLength(2);
    expect(hookCalls[1].map((m) => m.text)).toEqual(['m1', 'm2']); // count=2 유지 목표: kept=[m3,m4]
    resolveHook(true);
    await flush();
    expect(store.history('general', { limit: 10 }).map((m) => m.text)).toEqual(['m3', 'm4']);
  });

  it('요약 대상(dropped) 메시지는 위키에 저장된 것과 동일한 내용이고, 제거는 그 이후에만 일어난다(순서 증명)', async () => {
    const order: string[] = [];
    let wikiSaved: string[] = [];
    store.setAutoCompactHook(async (_channelId, dropped) => {
      order.push('summarize-start');
      wikiSaved = dropped.map((m) => m.text); // "위키 게시"를 흉내(실제 게시 성공을 표현)
      order.push('summarize-done');
      return true;
    });
    store.appendMessage('general', { authorId: 'owner', text: 'old-1' });
    store.appendMessage('general', { authorId: 'owner', text: 'old-2' });
    store.appendMessage('general', { authorId: 'owner', text: 'new-1' }); // dropped=[old-1]

    // 훅이 아직 진행 중이거나 막 끝난 시점 — removeMessagesByIds는 훅 완료 이후에만 실행되므로,
    // "제거" 단계가 시작되기 전엔 이미 'summarize-done'이 order에 기록돼 있어야 한다.
    await flush();
    expect(order).toEqual(['summarize-start', 'summarize-done']);
    expect(wikiSaved).toEqual(['old-1']); // 위키에 저장된 내용 = dropped 메시지
    expect(store.history('general', { limit: 10 }).map((m) => m.text)).toEqual(['old-2', 'new-1']); // 그 후 제거
  });
});
