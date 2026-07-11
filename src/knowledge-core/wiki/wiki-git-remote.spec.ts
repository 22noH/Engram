import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import { WikiGit } from './wiki-git';
import { PathResolver } from '../../pal/path-resolver';

// 한 두뇌의 위키 폴더에 페이지 파일을 쓰고 커밋하는 헬퍼(WikiEngine 없이 git만 검증).
async function writePage(dataDir: string, slug: string, body: string): Promise<void> {
  const pagesDir = path.join(dataDir, 'wiki', 'pages', 'default');
  await fs.promises.mkdir(pagesDir, { recursive: true });
  await fs.promises.writeFile(path.join(pagesDir, `${slug}.md`), body);
}
function readPage(dataDir: string, slug: string): string {
  return fs.readFileSync(path.join(dataDir, 'wiki', 'pages', 'default', `${slug}.md`), 'utf8');
}

describe('WikiGit 원격', () => {
  let remote: string; let dirA: string; let dirB: string;
  let gitA: WikiGit; let gitB: WikiGit;

  beforeEach(async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-wg-'));
    remote = path.join(base, 'remote.git');
    dirA = path.join(base, 'A');
    dirB = path.join(base, 'B');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]); // 빈 중앙 원격
    gitA = new WikiGit(new PathResolver(dirA));
    gitB = new WikiGit(new PathResolver(dirB));
  });
  afterEach(() => { /* base tmpdir는 OS가 정리; 명시 rm은 생략(핸들 안전) */ });

  it('A push → B가 pull로 받아온다', async () => {
    await writePage(dirA, 'alpha', 'from-A');
    await gitA.ensureRemote(remote);
    await gitA.commitAll('add alpha');
    expect((await gitA.push('main')).ok).toBe(true);

    await gitB.ensureRemote(remote);
    const pr = await gitB.pull('main');
    expect(pr).toEqual({ ok: true, conflict: false });
    expect(readPage(dirB, 'alpha')).toBe('from-A');
  });

  it('push 거부(원격 앞섬) → pull+재시도로 성공', async () => {
    // A가 먼저 올린다
    await writePage(dirA, 'alpha', 'A1'); await gitA.ensureRemote(remote); await gitA.commitAll('a1'); await gitA.push('main');
    // B가 원격을 모른 채(=pull 전) 다른 페이지를 커밋하고 push → 거부되어야 하고, 내부 pull+재시도로 성공
    await gitB.ensureRemote(remote);
    await writePage(dirB, 'beta', 'B1'); await gitB.commitAll('b1');
    const ps = await gitB.push('main');
    expect(ps).toEqual({ ok: true, conflict: false });
    // A가 pull하면 두 페이지 다 보인다
    await gitA.pull('main');
    expect(readPage(dirA, 'alpha')).toBe('A1');
    expect(readPage(dirA, 'beta')).toBe('B1');
  });

  it('같은 페이지 다른 편집 동시 → pull 충돌 시 abort+로컬 유지', async () => {
    await writePage(dirA, 'alpha', 'base'); await gitA.ensureRemote(remote); await gitA.commitAll('base'); await gitA.push('main');
    await gitB.ensureRemote(remote); await gitB.pull('main'); // B도 base 확보
    // A가 alpha를 A로 바꿔 push
    await writePage(dirA, 'alpha', 'A-version'); await gitA.commitAll('a-edit'); await gitA.push('main');
    // B가 같은 alpha를 B로 바꿔 커밋 후 pull → 충돌 → abort, 로컬(B) 유지
    await writePage(dirB, 'alpha', 'B-version'); await gitB.commitAll('b-edit');
    const pr = await gitB.pull('main');
    expect(pr.conflict).toBe(true);
    expect(readPage(dirB, 'alpha')).toBe('B-version'); // 로컬 유지(손상 없음)
  });

  it('미커밋 로컬 변경 중 pull(원격이 같은 파일 갱신) → 성공 주장 안 함·로컬 손상 없음', async () => {
    // 공통 base 확보
    await writePage(dirA, 'alpha', 'base'); await gitA.ensureRemote(remote); await gitA.commitAll('base'); await gitA.push('main');
    await gitB.ensureRemote(remote); await gitB.pull('main');
    // A가 원격의 alpha를 갱신
    await writePage(dirA, 'alpha', 'A-remote'); await gitA.commitAll('a-remote'); await gitA.push('main');
    // B가 alpha를 미커밋으로 더럽힌 채 pull
    await writePage(dirB, 'alpha', 'B-uncommitted-dirty');
    const pr = await gitB.pull('main');
    expect(pr.ok).toBe(false);            // 병합 안 됐으니 성공 주장 금지
    expect(pr.conflict).toBe(false);      // 내용충돌(UU)은 아님
    const body = readPage(dirB, 'alpha');
    expect(body).toBe('B-uncommitted-dirty'); // 로컬 유지
    expect(body).not.toContain('<<<<<<<');     // 충돌 마커 없음(손상 없음)
  });
});
