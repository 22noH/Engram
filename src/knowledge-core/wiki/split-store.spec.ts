import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findSplitStores, splitStoreWarning, probeRedirect, importSplitStorePages } from './split-store';

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

// ★2026-07-30: 경고만 찍는 걸로는 안 된다 — 11장이 몇 주 갇혀 있었고 사용자가 손으로 옮겼다.
// 컨테이너 안에서는 진짜 폴더에 쓸 수단이 없으므로(그게 OS가 하는 일), 가상화 밖에 있는 앱이 데려온다.
describe('importSplitStorePages', () => {
  const tmps: string[] = [];
  function makeRoot(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-import-'));
    tmps.push(d);
    return d;
  }
  function page(dir: string, name: string, body = 'x'): string {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${name}.md`);
    fs.writeFileSync(p, `---\ntitle: ${name}\nstatus: published\n---\n${body}`);
    return p;
  }
  // 방금 쓴 파일은 SETTLE_MS(3초) 안이라 건너뛰어진다 — 테스트는 시계를 앞으로 밀어
  // "이미 안정된 파일"로 만든다(실시간 대기 없이 같은 경로를 검증).
  const settled = { now: Date.now() + 60_000 };
  function setup(): { dataDir: string; env: NodeJS.ProcessEnv; mine: string; theirs: string } {
    const root = makeRoot();
    const dataDir = path.join(root, 'real', 'engram');
    const local = path.join(root, 'Local');
    return {
      dataDir,
      env: { LOCALAPPDATA: local } as NodeJS.ProcessEnv,
      mine: path.join(dataDir, 'wiki', 'pages', 'default'),
      theirs: path.join(local, 'Packages', 'Claude_x', 'LocalCache', 'Roaming', 'engram', 'wiki', 'pages', 'default'),
    };
  }
  afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

  // ★★적대적 검토가 재현한 치명 버그(2026-07-30). 처음 구현은 "대상 파일이 있으면 가져온 것"으로
  // 판정했다. 원본은 절대 지우지 않으므로, 사용자가 앱에서 페이지를 지우면 다음 부팅에 되살아난다 —
  // 부팅마다, 영원히. 사용자는 막을 방법이 없다(그 사본은 다른 앱 사설 폴더에 있어 안 보인다).
  it('앱에서 지운 페이지는 되살아나지 않는다(삭제가 유지된다)', async () => {
    const { dataDir, env, mine, theirs } = setup();
    page(theirs, 'secret-note');

    expect((await importSplitStorePages(dataDir, { env, ...settled })).imported).toEqual(['default/secret-note.md']);
    // 사용자가 앱에서 삭제(WikiEngine.deletePage가 하는 일 = unlink)
    fs.unlinkSync(path.join(mine, 'secret-note.md'));

    const second = await importSplitStorePages(dataDir, { env, ...settled });
    expect(second.imported).toEqual([]);
    expect(fs.existsSync(path.join(mine, 'secret-note.md'))).toBe(false); // 되살아나지 않았다
  });

  // 충돌 페이지는 더 나빴다: 지우면 **낡은 샌드박스 버전**이 되살아난다.
  it('충돌로 남겨둔 페이지를 지워도 낡은 사본이 되살아나지 않는다', async () => {
    const { dataDir, env, mine, theirs } = setup();
    page(mine, 'same-name', '앱이 쓴 최신 내용');
    page(theirs, 'same-name', '낡은 샌드박스 내용');

    expect((await importSplitStorePages(dataDir, { env, ...settled })).conflicts).toEqual(['default/same-name.md']);
    fs.unlinkSync(path.join(mine, 'same-name.md'));

    const second = await importSplitStorePages(dataDir, { env, ...settled });
    expect(second.imported).toEqual([]);
    expect(fs.existsSync(path.join(mine, 'same-name.md'))).toBe(false);
  });

  // 원본이 진짜로 새 내용이 되면 그때는 다시 데려와야 한다(원장이 영구 차단이 되면 안 된다).
  it('원본 내용이 바뀌면 다시 데려온다', async () => {
    const { dataDir, env, mine, theirs } = setup();
    page(theirs, 'evolving', 'v1');
    await importSplitStorePages(dataDir, { env, ...settled });
    fs.unlinkSync(path.join(mine, 'evolving.md'));

    page(theirs, 'evolving', 'v2 — 나중에 저장된 새 내용');
    const r = await importSplitStorePages(dataDir, { env, ...settled });
    expect(r.imported).toEqual(['default/evolving.md']);
    expect(fs.readFileSync(path.join(mine, 'evolving.md'), 'utf8')).toContain('v2');
  });

  // 컨테이너 쪽은 평범한 writeFile로 쓴다 — 저장 도중에 복사하면 잘린 사본이 영구 사본이 된다.
  it('막 쓰인 파일은 이번 부팅에 데려오지 않는다(잘린 사본 방지)', async () => {
    const { dataDir, env, mine, theirs } = setup();
    page(theirs, 'mid-write');
    const r = await importSplitStorePages(dataDir, { env }); // now=실제 시각 → 방금 쓴 파일
    expect(r.imported).toEqual([]);
    expect(r.skipped).toEqual(['default/mid-write.md']);
    expect(fs.existsSync(path.join(mine, 'mid-write.md'))).toBe(false);
    // 다음 부팅(안정된 뒤)에는 데려온다 — 영구 차단이 아니다.
    expect((await importSplitStorePages(dataDir, { env, ...settled })).imported).toEqual(['default/mid-write.md']);
  });

  // 깨진 바이트를 저장소에 들이면 곧이어 도는 listPages가 실패해 부팅이 끝나지 않는다.
  it('파싱이 안 되는 파일은 들이지 않는다(부팅 정지 방지)', async () => {
    const { dataDir, env, mine, theirs } = setup();
    fs.mkdirSync(theirs, { recursive: true });
    fs.writeFileSync(path.join(theirs, 'broken.md'), ['---', 'title: [닫히지 않은', ''].join('\n'));
    page(theirs, 'fine');

    const validate = (text: string) => { if (text.includes('[닫히지 않은')) throw new Error('YAML 깨짐'); };
    const r = await importSplitStorePages(dataDir, { env, ...settled, validate });
    expect(r.imported).toEqual(['default/fine.md']);
    expect(r.skipped).toEqual(['default/broken.md']);
    expect(fs.existsSync(path.join(mine, 'broken.md'))).toBe(false);
  });

  // 커밋이 성공해야 원장에 남긴다 — 실패하면 다음 부팅이 커밋만 다시 시도한다.
  it('커밋이 실패하면 기록하지 않고 다음 부팅에 재시도한다', async () => {
    const { dataDir, env, mine, theirs } = setup();
    page(theirs, 'needs-commit');

    const first = await importSplitStorePages(dataDir, { env, ...settled, commit: () => Promise.reject(new Error('git 실패')) });
    expect(first.imported).toEqual(['default/needs-commit.md']); // 파일은 제자리에 있다
    expect(first.failed).toEqual(['default/needs-commit.md']);
    expect(fs.existsSync(path.join(mine, 'needs-commit.md'))).toBe(true);

    const committed: string[] = [];
    const second = await importSplitStorePages(dataDir, { env, ...settled, commit: (rel) => { committed.push(rel); return Promise.resolve(); } });
    expect(committed).toEqual([path.join('pages', 'default', 'needs-commit.md')]); // 커밋만 재시도
    expect(second.failed).toEqual([]);

    // 세 번째 부팅은 조용하다(원장에 남았다).
    const third: string[] = [];
    await importSplitStorePages(dataDir, { env, ...settled, commit: (rel) => { third.push(rel); return Promise.resolve(); } });
    expect(third).toEqual([]);
  });

  it('가져온 페이지마다 커밋 경로를 넘긴다(위키 루트 기준 상대경로)', async () => {
    const { dataDir, env, theirs } = setup();
    page(theirs, 'tracked');
    const seen: string[] = [];
    await importSplitStorePages(dataDir, { env, ...settled, commit: (rel) => { seen.push(rel); return Promise.resolve(); } });
    expect(seen).toEqual([path.join('pages', 'default', 'tracked.md')]);
  });

  it('갇힌 페이지를 내 저장소로 데려온다', async () => {
    const { dataDir, env, mine, theirs } = setup();
    page(mine, 'here');
    page(theirs, 'trapped-1');
    page(theirs, 'trapped-2');

    const r = await importSplitStorePages(dataDir, { env, ...settled });
    expect(r.imported.sort()).toEqual(['default/trapped-1.md', 'default/trapped-2.md']);
    expect(fs.readdirSync(mine).sort()).toEqual(['here.md', 'trapped-1.md', 'trapped-2.md']);
    expect(fs.readFileSync(path.join(mine, 'trapped-1.md'), 'utf8')).toContain('title: trapped-1');
  });

  it('원본은 지우지 않는다(실패해도 잃는 게 없어야 한다)', async () => {
    const { dataDir, env, theirs } = setup();
    page(theirs, 'keep-me');
    await importSplitStorePages(dataDir, { env, ...settled });
    expect(fs.existsSync(path.join(theirs, 'keep-me.md'))).toBe(true);
  });

  it('두 번째 부팅은 아무것도 하지 않는다(같은 바이트 = 이미 가져옴)', async () => {
    const { dataDir, env, theirs } = setup();
    page(theirs, 'once');
    expect((await importSplitStorePages(dataDir, { env, ...settled })).imported).toHaveLength(1);
    const second = await importSplitStorePages(dataDir, { env, ...settled });
    expect(second.imported).toEqual([]);
    expect(second.conflicts).toEqual([]); // 같은 내용이면 충돌도 아니다
  });

  it('내용이 다른 같은 이름은 덮어쓰지 않고 충돌로 보고한다(앱 쪽이 이긴다)', async () => {
    const { dataDir, env, mine, theirs } = setup();
    page(mine, 'same-name', '앱이 쓴 최신 내용');
    page(theirs, 'same-name', '샌드박스의 낡은 내용');

    const r = await importSplitStorePages(dataDir, { env, ...settled });
    expect(r.imported).toEqual([]);
    expect(r.conflicts).toEqual(['default/same-name.md']);
    expect(fs.readFileSync(path.join(mine, 'same-name.md'), 'utf8')).toContain('앱이 쓴 최신 내용');
  });

  it('.md가 아닌 것과 git 내부는 가져오지 않는다', async () => {
    const { dataDir, env, mine, theirs } = setup();
    fs.mkdirSync(theirs, { recursive: true });
    fs.writeFileSync(path.join(theirs, 'notes.txt'), 'x');
    fs.mkdirSync(path.join(theirs, '..', '..', '.git'), { recursive: true });
    fs.writeFileSync(path.join(theirs, '..', '..', '.git', 'HEAD'), 'ref: x');
    page(theirs, 'real-page');

    const r = await importSplitStorePages(dataDir, { env, ...settled });
    expect(r.imported).toEqual(['default/real-page.md']);
    expect(fs.existsSync(path.join(mine, 'notes.txt'))).toBe(false);
  });

  it('갈라진 저장소가 없으면 아무 일도 없다(회귀 0)', async () => {
    const { dataDir, env, mine } = setup();
    page(mine, 'only');
    const r = await importSplitStorePages(dataDir, { env, ...settled });
    expect(r).toEqual({ imported: [], conflicts: [], skipped: [], failed: [], from: [] });
    expect(fs.readdirSync(mine)).toEqual(['only.md']);
  });

  it('임시 파일을 남기지 않는다(부분 쓰기 흔적 금지)', async () => {
    const { dataDir, env, mine, theirs } = setup();
    page(theirs, 'atomic');
    await importSplitStorePages(dataDir, { env, ...settled });
    expect(fs.readdirSync(mine).filter((f) => f.includes('importing'))).toEqual([]);
  });

  it('여러 사용자 폴더를 각각 제 자리로 가져온다', async () => {
    const { dataDir, env, theirs } = setup();
    const otherUser = path.join(theirs, '..', 'alice');
    page(theirs, 'for-default');
    page(otherUser, 'for-alice');

    const r = await importSplitStorePages(dataDir, { env, ...settled });
    expect(r.imported.sort()).toEqual(['alice/for-alice.md', 'default/for-default.md']);
    expect(fs.existsSync(path.join(dataDir, 'wiki', 'pages', 'alice', 'for-alice.md'))).toBe(true);
  });
});
