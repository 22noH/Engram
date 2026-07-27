import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findSplitStores, splitStoreWarning } from './split-store';

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
