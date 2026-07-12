import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import { WikiGit } from './wiki-git';
import { PathResolver } from '../../pal/path-resolver';

// 실제 git 서브프로세스를 테스트당 15~20회 실행 — 콜드 Windows 러너에서 기본 5000ms를 넘길 수 있다.
jest.setTimeout(30000);

// 한 두뇌의 위키 폴더에 페이지 파일을 쓰고 커밋하는 헬퍼(WikiEngine 없이 git만 검증).
async function writePage(dataDir: string, slug: string, body: string): Promise<void> {
  const pagesDir = path.join(dataDir, 'wiki', 'pages', 'default');
  await fs.promises.mkdir(pagesDir, { recursive: true });
  await fs.promises.writeFile(path.join(pagesDir, `${slug}.md`), body);
}
function readPage(dataDir: string, slug: string): string {
  return fs.readFileSync(path.join(dataDir, 'wiki', 'pages', 'default', `${slug}.md`), 'utf8');
}

// frontmatter + 본문을 gray-matter 포맷으로 직접 쓴다(WikiEngine 없이).
async function writeFullPage(dataDir: string, slug: string, opts: { title?: string; updated?: string; sources?: string[]; body: string }): Promise<void> {
  const pagesDir = path.join(dataDir, 'wiki', 'pages', 'default');
  await fs.promises.mkdir(pagesDir, { recursive: true });
  const fmYaml = [
    '---',
    `title: ${opts.title ?? 'T'}`,
    'category: C',
    'status: published',
    `sources:${opts.sources && opts.sources.length ? '\n' + opts.sources.map((s) => `  - ${s}`).join('\n') : ' []'}`,
    'created: 2026-01-01T00:00:00.000Z',
    `updated: ${opts.updated ?? '2026-01-01T00:00:00.000Z'}`,
    '---',
    opts.body,
    '',
  ].join('\n');
  await fs.promises.writeFile(path.join(pagesDir, `${slug}.md`), fmYaml);
}
function readBody(dataDir: string, slug: string): string {
  const raw = fs.readFileSync(path.join(dataDir, 'wiki', 'pages', 'default', `${slug}.md`), 'utf8');
  return raw.split('---').slice(2).join('---').trim(); // frontmatter 뒤 본문
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

  it('같은 페이지 다른 편집 동시 → pull 충돌 시 자동 병합(15c, conflict:false·양쪽 보존)', async () => {
    await writeFullPage(dirA, 'alpha', { body: 'base', updated: '2026-01-01T00:00:00.000Z' });
    await gitA.ensureRemote(remote); await gitA.commitAll('base'); await gitA.push('main');
    await gitB.ensureRemote(remote); await gitB.pull('main'); // B도 base 확보
    // A가 alpha를 A로 바꿔 push
    await writeFullPage(dirA, 'alpha', { body: 'A-version', updated: '2026-01-02T00:00:00.000Z' });
    await gitA.commitAll('a-edit'); await gitA.push('main');
    // B가 같은 alpha를 B로 바꿔 커밋 후 pull → 충돌 → 15c 자동 병합(abort 아님), 양쪽 보존
    await writeFullPage(dirB, 'alpha', { body: 'B-version', updated: '2026-01-03T00:00:00.000Z' });
    await gitB.commitAll('b-edit');
    const pr = await gitB.pull('main');
    expect(pr).toEqual({ ok: true, conflict: false });
    const body = readBody(dirB, 'alpha');
    expect(body).toContain('A-version');
    expect(body).toContain('B-version'); // 양쪽 다 보존(손실 0)
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

  it('한쪽 삭제 + 다른쪽 수정 동시 → pull 시 "삭제가 이김"(conflict:false·파일 사라짐)', async () => {
    // 공통 base 확보
    await writeFullPage(dirA, 'alpha', { body: 'base', updated: '2026-01-01T00:00:00.000Z' });
    await gitA.ensureRemote(remote); await gitA.commitAll('base'); await gitA.push('main');
    await gitB.ensureRemote(remote); await gitB.pull('main');
    // A가 alpha를 하드삭제하고 push
    fs.unlinkSync(path.join(dirA, 'wiki', 'pages', 'default', 'alpha.md'));
    await gitA.commitAll('delete alpha'); await gitA.push('main');
    // B가 같은 alpha를 수정·커밋 후 pull → delete/modify 충돌 → 삭제가 이김
    await writeFullPage(dirB, 'alpha', { body: 'B-edit', updated: '2026-01-03T00:00:00.000Z' });
    await gitB.commitAll('b-edit');
    const pr = await gitB.pull('main');
    expect(pr).toEqual({ ok: true, conflict: false });
    // B에서도 파일이 사라짐(삭제 반영)
    expect(fs.existsSync(path.join(dirB, 'wiki', 'pages', 'default', 'alpha.md'))).toBe(false);
  });

  describe('WikiGit 동시 편집 자동 병합', () => {
    // (상위 describe의 beforeEach가 remote/dirA/dirB/gitA/gitB를 준비한다)
    it('본문 다른 줄 편집 + frontmatter 다름 → 깨끗 병합(양쪽 다 있음, conflict:false)', async () => {
      // base: 5줄
      await writeFullPage(dirA, 'p', { body: 'L1\nL2\nL3\nL4\nL5', updated: '2026-01-01T00:00:00.000Z', sources: ['s0'] });
      await gitA.ensureRemote(remote); await gitA.commitAll('base'); await gitA.push('main');
      await gitB.ensureRemote(remote); await gitB.pull('main');
      // A는 L1, B는 L5 편집 + 각자 다른 source/updated
      await writeFullPage(dirA, 'p', { body: 'A1\nL2\nL3\nL4\nL5', updated: '2026-01-02T00:00:00.000Z', sources: ['s0', 'sA'] });
      await gitA.commitAll('a'); await gitA.push('main');
      await writeFullPage(dirB, 'p', { body: 'L1\nL2\nL3\nL4\nB5', updated: '2026-01-03T00:00:00.000Z', sources: ['s0', 'sB'] });
      await gitB.commitAll('b');
      const pr = await gitB.pull('main');
      expect(pr).toEqual({ ok: true, conflict: false });
      const body = readBody(dirB, 'p');
      expect(body).toContain('A1'); // A의 편집
      expect(body).toContain('B5'); // B의 편집 — 둘 다 보존
      // push까지 되어 A도 pull하면 동일
      await gitB.push('main');
      await gitA.pull('main');
      expect(readBody(dirA, 'p')).toContain('A1');
      expect(readBody(dirA, 'p')).toContain('B5');
    });

    it('같은 줄 겹침 + bodyMerger 미주입 → union(양쪽 다 보존, conflict:false)', async () => {
      await writeFullPage(dirA, 'p', { body: 'base-line', updated: '2026-01-01T00:00:00.000Z' });
      await gitA.ensureRemote(remote); await gitA.commitAll('base'); await gitA.push('main');
      await gitB.ensureRemote(remote); await gitB.pull('main');
      await writeFullPage(dirA, 'p', { body: 'AAA-line', updated: '2026-01-02T00:00:00.000Z' });
      await gitA.commitAll('a'); await gitA.push('main');
      await writeFullPage(dirB, 'p', { body: 'BBB-line', updated: '2026-01-03T00:00:00.000Z' });
      await gitB.commitAll('b');
      const pr = await gitB.pull('main');
      expect(pr.conflict).toBe(false);
      const body = readBody(dirB, 'p');
      expect(body).toContain('AAA-line');
      expect(body).toContain('BBB-line'); // union — 손실 0
    });

    it('같은 줄 겹침 + bodyMerger 주입 → 그 출력이 병합 결과', async () => {
      gitB.setBodyMerger(async () => 'MERGED-BY-BRAIN');
      await writeFullPage(dirA, 'p', { body: 'base', updated: '2026-01-01T00:00:00.000Z' });
      await gitA.ensureRemote(remote); await gitA.commitAll('base'); await gitA.push('main');
      await gitB.ensureRemote(remote); await gitB.pull('main');
      await writeFullPage(dirA, 'p', { body: 'AAA', updated: '2026-01-02T00:00:00.000Z' });
      await gitA.commitAll('a'); await gitA.push('main');
      await writeFullPage(dirB, 'p', { body: 'BBB', updated: '2026-01-03T00:00:00.000Z' });
      await gitB.commitAll('b');
      await gitB.pull('main');
      expect(readBody(dirB, 'p')).toContain('MERGED-BY-BRAIN');
    });

    it('bodyMerger가 null 반환(두뇌 실패 모사) → union 폴백', async () => {
      gitB.setBodyMerger(async () => null);
      await writeFullPage(dirA, 'p', { body: 'base', updated: '2026-01-01T00:00:00.000Z' });
      await gitA.ensureRemote(remote); await gitA.commitAll('base'); await gitA.push('main');
      await gitB.ensureRemote(remote); await gitB.pull('main');
      await writeFullPage(dirA, 'p', { body: 'AAA', updated: '2026-01-02T00:00:00.000Z' });
      await gitA.commitAll('a'); await gitA.push('main');
      await writeFullPage(dirB, 'p', { body: 'BBB', updated: '2026-01-03T00:00:00.000Z' });
      await gitB.commitAll('b');
      await gitB.pull('main');
      const body = readBody(dirB, 'p');
      expect(body).toContain('AAA');
      expect(body).toContain('BBB');
    });

    it('공통 base 없는 add/add(양쪽이 같은 slug 새로 생성) → union 병합(둘 다 보존)', async () => {
      // A와 B가 원격을 공유하되, 같은 slug 'x'를 서로 독립적으로 새로 만든다(공통 조상 없음).
      await gitA.ensureRemote(remote);
      await gitB.ensureRemote(remote);
      await writeFullPage(dirA, 'x', { body: 'ADDED-BY-A', updated: '2026-01-02T00:00:00.000Z' });
      await gitA.commitAll('a-add'); await gitA.push('main');
      await writeFullPage(dirB, 'x', { body: 'ADDED-BY-B', updated: '2026-01-03T00:00:00.000Z' });
      await gitB.commitAll('b-add');
      const pr = await gitB.pull('main'); // B가 pull → add/add 충돌 → 자동 병합
      expect(pr.conflict).toBe(false);
      const body = readBody(dirB, 'x');
      expect(body).toContain('ADDED-BY-A');
      expect(body).toContain('ADDED-BY-B'); // 손실 0
    });
  });
});
