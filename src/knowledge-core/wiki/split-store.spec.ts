import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findSplitStores, splitStoreWarning, probeRedirect } from './split-store';

// 2026-07-27 실사고: 위키가 진짜 %APPDATA%와 Claude 패키지 컨테이너로 조용히 갈라져 있었다.
// 앱은 2장, 컨테이너엔 11장. 아무도 몰랐고 알 방법도 없었다 — 그 침묵을 깨는 게 이 코드다.
describe('findSplitStores', () => {
  const tmps: string[] = [];
  function makeRoot(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-split-'));
    tmps.push(d);
    return d;
  }
  function writePages(pagesDir: string, names: string[]): void {
    const dir = path.join(pagesDir, 'default');
    fs.mkdirSync(dir, { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(dir, `${n}.md`), '---\nstatus: published\n---\nx');
  }
  afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

  it('컨테이너에 페이지가 있으면 경로와 장수를 돌려준다', () => {
    const root = makeRoot();
    const dataDir = path.join(root, 'real', 'engram');
    writePages(path.join(dataDir, 'wiki', 'pages'), ['a', 'b']);
    const local = path.join(root, 'Local');
    const container = path.join(local, 'Packages', 'Claude_x', 'LocalCache', 'Roaming', 'engram', 'wiki', 'pages');
    writePages(container, ['c', 'd', 'e']);

    const found = findSplitStores(dataDir, { LOCALAPPDATA: local } as NodeJS.ProcessEnv);
    expect(found).toHaveLength(1);
    expect(found[0].pages).toBe(3);
    expect(found[0].pagesDir).toBe(container);
  });

  it('갈라진 게 없으면 빈 배열(조용히)', () => {
    const root = makeRoot();
    const dataDir = path.join(root, 'real', 'engram');
    writePages(path.join(dataDir, 'wiki', 'pages'), ['a']);
    fs.mkdirSync(path.join(root, 'Local', 'Packages', 'Other_y'), { recursive: true });
    expect(findSplitStores(dataDir, { LOCALAPPDATA: path.join(root, 'Local') } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('빈 컨테이너 저장소는 경고하지 않는다(폴더만 있고 페이지 0장)', () => {
    const root = makeRoot();
    const dataDir = path.join(root, 'real', 'engram');
    const local = path.join(root, 'Local');
    fs.mkdirSync(path.join(local, 'Packages', 'Claude_x', 'LocalCache', 'Roaming', 'engram', 'wiki', 'pages', 'default'), { recursive: true });
    expect(findSplitStores(dataDir, { LOCALAPPDATA: local } as NodeJS.ProcessEnv)).toEqual([]);
  });

  // ★내가 그 컨테이너 안에서 도는 경우 — 내 저장소를 "남의 저장소"라고 경고하면 안 된다.
  it('내가 쓰는 폴더가 곧 그 컨테이너면 갈라진 게 아니다', () => {
    const root = makeRoot();
    const local = path.join(root, 'Local');
    const dataDir = path.join(local, 'Packages', 'Claude_x', 'LocalCache', 'Roaming', 'engram');
    writePages(path.join(dataDir, 'wiki', 'pages'), ['a', 'b']);
    expect(findSplitStores(dataDir, { LOCALAPPDATA: local } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('LOCALAPPDATA가 없으면(비윈도우) 탐지하지 않는다', () => {
    expect(findSplitStores('/home/u/.engram', {} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('경고문에 양쪽 경로와 장수가 들어간다(사용자가 바로 옮길 수 있게)', () => {
    const root = makeRoot();
    const dataDir = path.join(root, 'real', 'engram');
    writePages(path.join(dataDir, 'wiki', 'pages'), ['a']);
    const local = path.join(root, 'Local');
    writePages(path.join(local, 'Packages', 'Claude_x', 'LocalCache', 'Roaming', 'engram', 'wiki', 'pages'), ['c', 'd']);

    const msg = splitStoreWarning(dataDir, { LOCALAPPDATA: local } as NodeJS.ProcessEnv);
    expect(msg).toContain(path.join(dataDir, 'wiki', 'pages'));
    expect(msg).toContain('Claude_x');
    expect(msg).toContain('2 pages');
  });

  it('갈라진 게 없으면 경고문은 null', () => {
    const root = makeRoot();
    const dataDir = path.join(root, 'real', 'engram');
    writePages(path.join(dataDir, 'wiki', 'pages'), ['a']);
    expect(splitStoreWarning(dataDir, { LOCALAPPDATA: path.join(root, 'Local') } as NodeJS.ProcessEnv)).toBeNull();
  });
});

// 리디렉션 프로브 — 나열로는 알 수 없는 "내 쓰기가 어디로 가나"를 실제로 써 보고 판정한다.
// 양성 케이스(진짜 리디렉션)는 단위 테스트로 못 만든다(OS가 하는 일이라 흉내낼 수 없다) —
// 2026-07-27 이 머신에서 실측으로 확인했다: %APPDATA%\engram-probe-test →
// Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\engram-probe-test 를 정확히 돌려줬다.
// 여기서는 "막지 말아야 할 때 막지 않는지"와 뒷정리를 고정한다.
describe('probeRedirect', () => {
  const tmps: string[] = [];
  function makeRoot(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-probe-'));
    tmps.push(d);
    return d;
  }
  afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

  it('LOCALAPPDATA가 없으면 판정하지 않는다(비윈도우 — 막지 않음)', () => {
    expect(probeRedirect(makeRoot(), {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('Packages 폴더가 없으면 null(모르면 막지 않는다)', () => {
    const root = makeRoot();
    expect(probeRedirect(path.join(root, 'engram'), { LOCALAPPDATA: path.join(root, 'Local') } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('리디렉션이 없으면 null이고 표식 파일을 남기지 않는다', () => {
    const root = makeRoot();
    const dataDir = path.join(root, 'engram');
    const local = path.join(root, 'Local');
    fs.mkdirSync(path.join(local, 'Packages', 'Some_pkg'), { recursive: true });
    expect(probeRedirect(dataDir, { LOCALAPPDATA: local } as NodeJS.ProcessEnv)).toBeNull();
    expect(fs.readdirSync(dataDir)).toEqual([]); // 뒷정리 확인 — 데이터 폴더에 쓰레기를 남기지 않는다
  });

  it('내가 곧 그 컨테이너 폴더면 리디렉션이 아니다(자기 자신 오탐 금지)', () => {
    const root = makeRoot();
    const local = path.join(root, 'Local');
    const dataDir = path.join(local, 'Packages', 'Claude_x', 'LocalCache', 'Roaming', 'engram');
    fs.mkdirSync(dataDir, { recursive: true });
    expect(probeRedirect(dataDir, { LOCALAPPDATA: local } as NodeJS.ProcessEnv)).toBeNull();
  });
});
