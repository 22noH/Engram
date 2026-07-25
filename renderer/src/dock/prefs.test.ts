import {
  addServer, allowSite, DEFAULT_PREFS, forgetSite, isSiteAllowed, loadAllowedSites, loadPrefs,
  loadServers, previewPartition, removeServer, saveServers, savePrefs, serverUrl,
} from './prefs';

beforeEach(() => localStorage.clear());

describe('개발 서버 목록(채널별)', () => {
  it('추가하고 다시 읽는다', () => {
    const s = addServer('ch1', { name: 'renderer', port: 5173, command: 'npm run dev' })!;
    expect(loadServers('ch1')).toEqual([{ id: s.id, name: 'renderer', port: 5173, command: 'npm run dev' }]);
    expect(loadServers('ch2')).toEqual([]); // 채널별로 분리
  });

  it('포트를 문자열로 받아도 숫자로 저장한다(입력폼)', () => {
    const s = addServer('ch1', { name: 'x', port: '5174', command: 'npm start' })!;
    expect(s.port).toBe(5174);
  });

  it('이름이나 명령이 비면 추가하지 않는다', () => {
    expect(addServer('ch1', { name: '  ', port: 1, command: 'npm run dev' })).toBeNull();
    expect(addServer('ch1', { name: 'x', port: 1, command: '   ' })).toBeNull();
    expect(loadServers('ch1')).toEqual([]);
  });

  it('포트가 없거나 이상하면 0(자동 이동 안 함)', () => {
    expect(addServer('ch1', { name: 'x', port: '', command: 'a' })!.port).toBe(0);
    expect(addServer('ch1', { name: 'y', port: 99999, command: 'a' })!.port).toBe(0);
    expect(serverUrl({ id: '1', name: 'x', port: 0, command: 'a' })).toBeNull();
    expect(serverUrl({ id: '1', name: 'x', port: 5173, command: 'a' })).toBe('http://localhost:5173');
  });

  it('삭제한다', () => {
    const a = addServer('ch1', { name: 'a', port: 1, command: 'a' })!;
    addServer('ch1', { name: 'b', port: 2, command: 'b' });
    removeServer('ch1', a.id);
    expect(loadServers('ch1').map((s) => s.name)).toEqual(['b']);
  });

  it('깨진 값은 걸러낸다(throw 금지)', () => {
    localStorage.setItem('engram.dock.servers', JSON.stringify({ ch1: [{ name: 'ok', command: 'c', port: 1 }, 42, null, { name: '' }] }));
    expect(loadServers('ch1').map((s) => s.name)).toEqual(['ok']);
    localStorage.setItem('engram.dock.servers', 'not json');
    expect(loadServers('ch1')).toEqual([]);
  });

  it('빈 목록을 저장하면 그 채널 항목을 지운다', () => {
    addServer('ch1', { name: 'a', port: 1, command: 'a' });
    saveServers('ch1', []);
    expect(localStorage.getItem('engram.dock.servers')).toBe('{}');
  });
});

describe('허용된 사이트', () => {
  it('허용하면 기억하고, 잊으면 지워진다', () => {
    expect(isSiteAllowed('example.com')).toBe(false);
    allowSite('Example.COM');
    expect(loadAllowedSites()).toEqual(['example.com']);
    expect(isSiteAllowed('example.com')).toBe(true);
    forgetSite('example.com');
    expect(isSiteAllowed('example.com')).toBe(false);
  });

  it('중복 허용은 한 번만 쌓인다, 빈 값은 무시', () => {
    allowSite('a.com'); allowSite('a.com'); allowSite('  ');
    expect(loadAllowedSites()).toEqual(['a.com']);
  });

  it('null 호스트는 허용된 적 없다', () => {
    expect(isSiteAllowed(null)).toBe(false);
  });

  it('깨진 값은 빈 목록', () => {
    localStorage.setItem('engram.dock.allowedSites', '{"nope":1}');
    expect(loadAllowedSites()).toEqual([]);
  });
});

describe('토글 · 파티션', () => {
  it('기본은 둘 다 꺼짐(세션 유지 안 함)', () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    expect(loadPrefs().keepSession).toBe(false);
  });

  it('저장하고 다시 읽는다', () => {
    savePrefs({ openLinksHere: true, keepSession: true });
    expect(loadPrefs()).toEqual({ openLinksHere: true, keepSession: true });
  });

  it('깨진 값은 기본값', () => {
    localStorage.setItem('engram.dock.prefs', 'x');
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('파티션은 항상 앱 세션과 분리된 이름이고, 유지 여부로만 갈린다', () => {
    expect(previewPartition(false)).toBe('engram-preview');
    expect(previewPartition(true)).toBe('persist:engram-preview');
  });
});
