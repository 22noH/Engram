import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GroupStore } from './group-store';

describe('GroupStore', () => {
  let dir: string;
  let store: GroupStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-groups-'));
    store = new GroupStore(dir);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('빈 상태에서 list()는 빈 배열', () => {
    expect(store.list()).toEqual([]);
  });

  it('create는 빈 그룹을 만들어 목록에 남긴다', () => {
    const g = store.create('디자인팀');
    expect(g.name).toBe('디자인팀');
    expect(g.memberIds).toEqual([]);
    expect(g.permissions).toEqual([]);
    expect(g.channelIds).toEqual([]);
    expect(typeof g.id).toBe('string');
    expect(typeof g.createdAt).toBe('string');
    expect(store.list().map((x) => x.id)).toEqual([g.id]);
  });

  it('get은 존재하는 id만 반환, 없으면 null', () => {
    const g = store.create('a');
    expect(store.get(g.id)?.name).toBe('a');
    expect(store.get('nope')).toBeNull();
  });

  it('rename은 이름을 바꾸고 true, 없는 id는 false', () => {
    const g = store.create('old');
    expect(store.rename(g.id, 'new')).toBe(true);
    expect(store.get(g.id)?.name).toBe('new');
    expect(store.rename('nope', 'x')).toBe(false);
  });

  it('remove는 그룹을 지우고 true, 없는 id는 false', () => {
    const g = store.create('a');
    expect(store.remove(g.id)).toBe(true);
    expect(store.get(g.id)).toBeNull();
    expect(store.remove(g.id)).toBe(false);
  });

  it('setMembers는 계정 id 목록을 저장(중복 제거), 계정 존재 검증은 하지 않는다(호출자 몫)', () => {
    const g = store.create('a');
    expect(store.setMembers(g.id, ['u1', 'u2', 'u1'])).toBe(true);
    expect(store.get(g.id)?.memberIds.sort()).toEqual(['u1', 'u2']);
    expect(store.setMembers('nope', ['u1'])).toBe(false);
  });

  it('setPermissions는 sanitizePermissions로 소독(허용 토큰만, 중복 제거)', () => {
    const g = store.create('a');
    expect(store.setPermissions(g.id, ['wiki.approve', 'bogus', 'wiki.approve', 'wiki.edit'])).toBe(true);
    expect(store.get(g.id)?.permissions.sort()).toEqual(['wiki.approve', 'wiki.edit']);
  });

  it('setChannels는 채널 id 목록을 저장(중복 제거)', () => {
    const g = store.create('a');
    expect(store.setChannels(g.id, ['c1', 'c2', 'c1'])).toBe(true);
    expect(store.get(g.id)?.channelIds.sort()).toEqual(['c1', 'c2']);
  });

  it('groupsOf는 그 계정이 속한 그룹만 반환', () => {
    const g1 = store.create('g1');
    const g2 = store.create('g2');
    store.create('g3'); // u1 소속 아님
    store.setMembers(g1.id, ['u1']);
    store.setMembers(g2.id, ['u1', 'u2']);
    const ids = store.groupsOf('u1').map((g) => g.id).sort();
    expect(ids).toEqual([g1.id, g2.id].sort());
    expect(store.groupsOf('nobody')).toEqual([]);
  });

  it('손상된 groups.json은 빈 목록(account-store 관례와 동일)', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'groups.json'), '{ not json');
    expect(store.list()).toEqual([]);
  });

  it("groups.json이 배열이 아니면 빈 목록", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'groups.json'), JSON.stringify({ oops: true }));
    expect(store.list()).toEqual([]);
  });

  it("'__proto__' 이름은 create/rename 모두 거부(예약어)", () => {
    expect(() => store.create('__proto__')).toThrow();
    expect(() => store.create('constructor')).toThrow();
    expect(() => store.create('prototype')).toThrow();
    const g = store.create('safe');
    expect(() => store.rename(g.id, '__proto__')).toThrow();
  });

  it('빈 이름은 거부', () => {
    expect(() => store.create('   ')).toThrow();
  });

  it("id가 '__proto__'류인 오염된 레코드는 로드 시 걸러진다(파일 직접 조작 시나리오)", () => {
    fs.mkdirSync(dir, { recursive: true });
    const poisoned = [
      { id: '__proto__', name: 'evil', memberIds: [], permissions: [], channelIds: [], createdAt: 'x' },
      { id: 'good-id', name: 'ok', memberIds: [], permissions: [], channelIds: [], createdAt: 'x' },
    ];
    fs.writeFileSync(path.join(dir, 'groups.json'), JSON.stringify(poisoned));
    const list = store.list();
    expect(list.map((g) => g.id)).toEqual(['good-id']);
  });

  it('이름 앞뒤 공백은 trim된다', () => {
    const g = store.create('  spaced  ');
    expect(g.name).toBe('spaced');
  });
});
