import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import { diffFile, diffStatus } from './git-diff';

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

afterAll(async () => {
  for (const d of tmpDirs) {
    await fs.rm(d, { recursive: true, force: true });
  }
});
