import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import { branchStatus, countAddedLines, diffFile, diffStatus, parseNumstat } from './git-diff';

const tmpDirs: string[] = [];

// 실 임시 git 레포: init → user.name/email 로컬 설정 → base 커밋. 이후 각 테스트가 수정/추가/삭제.
async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-gitdiff-'));
  tmpDirs.push(dir);
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@localhost');
  await fs.writeFile(path.join(dir, 'a.txt'), 'line1\nline2\n');
  await fs.writeFile(path.join(dir, 'b.txt'), 'to be deleted\n');
  await git.add(['a.txt', 'b.txt']);
  await git.commit('base');
  return dir;
}

describe('diffStatus', () => {
  it('수정/신규(untracked)/삭제 파일을 모두 나열한다', async () => {
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, 'a.txt'), 'line1\nline2 changed\n'); // modified
    await fs.writeFile(path.join(dir, 'c.txt'), 'new file\n'); // untracked
    await fs.rm(path.join(dir, 'b.txt')); // deleted

    const result = await diffStatus(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f.status]));
    expect(byPath['a.txt']).toBe('M');
    expect(byPath['c.txt']).toBe('?');
    expect(byPath['b.txt']).toBe('D');
  });

  it('스테이징된 신규 파일도 A로 나열한다', async () => {
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, 'd.txt'), 'staged new\n');
    await simpleGit(dir).add('d.txt');
    const result = await diffStatus(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f.status]));
    expect(byPath['d.txt']).toBe('A');
  });

  it('git 저장소가 아니면 not-repo를 반환한다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-gitdiff-norepo-'));
    tmpDirs.push(dir);
    const result = await diffStatus(dir);
    expect(result).toEqual({ ok: false, reason: 'not-repo' });
  });

  it('인자가 없거나 문자열이 아니면 error를 반환한다(never-throw)', async () => {
    // @ts-expect-error 의도적으로 잘못된 타입 전달
    expect(await diffStatus(undefined)).toEqual({ ok: false, reason: 'error' });
    expect(await diffStatus('')).toEqual({ ok: false, reason: 'error' });
  });
});

describe('diffFile', () => {
  it('수정된 파일의 unified diff를 반환한다', async () => {
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, 'a.txt'), 'line1\nline2 changed\n');
    const result = await diffFile(dir, 'a.txt');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diff).toContain('-line2');
    expect(result.diff).toContain('+line2 changed');
  });

  it('미추적(신규) 파일도 내용이 + 로 보이는 diff를 반환한다', async () => {
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, 'c.txt'), 'brand new content\n');
    const result = await diffFile(dir, 'c.txt');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diff).toContain('+brand new content');
    expect(result.diff).toContain('--- /dev/null');
  });

  it('삭제된 파일의 diff를 반환한다', async () => {
    const dir = await makeRepo();
    await fs.rm(path.join(dir, 'b.txt'));
    const result = await diffFile(dir, 'b.txt');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diff).toContain('-to be deleted');
  });

  it('git 저장소가 아니면 not-repo를 반환한다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-gitdiff-norepo2-'));
    tmpDirs.push(dir);
    const result = await diffFile(dir, 'a.txt');
    expect(result).toEqual({ ok: false, reason: 'not-repo' });
  });

  it('"-"로 시작하는 file 인자는 거부한다(옵션 인젝션 차단)', async () => {
    const dir = await makeRepo();
    const result = await diffFile(dir, '--upload-pack=calc');
    expect(result).toEqual({ ok: false, reason: 'error' });
  });

  it('file에 NUL 바이트가 있으면 거부한다', async () => {
    const dir = await makeRepo();
    const result = await diffFile(dir, 'a.txt\0evil');
    expect(result).toEqual({ ok: false, reason: 'error' });
  });

  it('인자가 없거나 문자열이 아니면 error를 반환한다(never-throw)', async () => {
    const dir = await makeRepo();
    // @ts-expect-error 의도적으로 잘못된 타입 전달
    expect(await diffFile(dir, undefined)).toEqual({ ok: false, reason: 'error' });
    // @ts-expect-error 의도적으로 잘못된 타입 전달
    expect(await diffFile(undefined, 'a.txt')).toEqual({ ok: false, reason: 'error' });
  });
});

describe('parseNumstat', () => {
  it('추가/삭제 줄 수를 합산한다', () => {
    expect(parseNumstat('3\t1\ta.txt\n10\t0\tsrc/b.ts\n')).toEqual({ added: 13, removed: 1 });
  });

  it('바이너리 파일(-\\t-)은 건너뛴다(NaN 방지)', () => {
    expect(parseNumstat('-\t-\timage.png\n5\t2\ta.txt\n')).toEqual({ added: 5, removed: 2 });
  });

  it('빈 출력은 0/0', () => {
    expect(parseNumstat('')).toEqual({ added: 0, removed: 0 });
  });
});

describe('countAddedLines', () => {
  it('개행 기준으로 줄 수를 센다', () => {
    expect(countAddedLines(Buffer.from('a\nb\nc\n'))).toBe(3);
  });

  it('마지막 줄이 개행으로 안 끝나도 한 줄로 센다', () => {
    expect(countAddedLines(Buffer.from('a\nb'))).toBe(2);
  });

  it('빈 파일은 0', () => {
    expect(countAddedLines(Buffer.alloc(0))).toBe(0);
  });

  it('바이너리(NUL 포함)는 0으로 — 숫자 부풀림 방지', () => {
    expect(countAddedLines(Buffer.from([0x89, 0x50, 0x00, 0x0a, 0x0a, 0x0a]))).toBe(0);
  });
});

describe('branchStatus', () => {
  it('브랜치명과 추가/삭제 줄 수(미추적 파일 포함)를 돌려준다', async () => {
    const dir = await makeRepo();
    await simpleGit(dir).checkoutLocalBranch('feat/voice');
    await fs.writeFile(path.join(dir, 'a.txt'), 'line1\nline2\nline3\nline4\n'); // +2
    await fs.rm(path.join(dir, 'b.txt')); // -1
    await fs.writeFile(path.join(dir, 'new.txt'), 'x\ny\n'); // untracked +2

    const r = await branchStatus(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.branch).toBe('feat/voice');
    expect(r.detached).toBe(false);
    expect(r.added).toBe(4); // a.txt +2, new.txt +2
    expect(r.removed).toBe(1); // b.txt
    expect(r.files).toBe(3);
  });

  it('변경이 없으면 0/0', async () => {
    const dir = await makeRepo();
    const r = await branchStatus(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect({ added: r.added, removed: r.removed, files: r.files }).toEqual({ added: 0, removed: 0, files: 0 });
  });

  it('git 저장소가 아니면 not-repo', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-branch-norepo-'));
    tmpDirs.push(dir);
    expect(await branchStatus(dir)).toEqual({ ok: false, reason: 'not-repo' });
  });

  it('인자가 없으면 error(never-throw)', async () => {
    // @ts-expect-error 의도적으로 잘못된 타입 전달
    expect(await branchStatus(undefined)).toEqual({ ok: false, reason: 'error' });
  });
});

afterAll(async () => {
  for (const d of tmpDirs) {
    await fs.rm(d, { recursive: true, force: true });
  }
});
