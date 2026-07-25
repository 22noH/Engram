import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hashFile, isSkippedDir, isTempName, listFolder } from './scan-folder';

describe('스캔 필터(순수 판정)', () => {
  it('편집기·오피스 임시 파일을 건너뛴다', () => {
    expect(isTempName('~$보고서.docx')).toBe(true);
    expect(isTempName('.DS_Store')).toBe(true);
    expect(isTempName('a.tmp')).toBe(true);
    expect(isTempName('a.crdownload')).toBe(true);
    expect(isTempName('Thumbs.db')).toBe(true);
    expect(isTempName('보고서.docx')).toBe(false);
  });

  it('들어가면 안 되는 디렉터리를 거른다', () => {
    expect(isSkippedDir('node_modules')).toBe(true);
    expect(isSkippedDir('.git')).toBe(true);
    expect(isSkippedDir('메모')).toBe(false);
  });
});

describe('폴더 스캔', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-scan-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('하위 폴더까지 훑고 상대경로를 슬래시로 통일한다', async () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.md'), 'a');
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'bb');
    const files = await listFolder(dir);
    expect(files.map((f) => f.rel).sort()).toEqual(['a.md', 'sub/b.txt']);
    expect(files.find((f) => f.rel === 'sub/b.txt')?.size).toBe(2);
  });

  it('임시·숨김 파일과 제외 디렉터리는 목록에 없다', async () => {
    fs.writeFileSync(path.join(dir, '~$x.docx'), 'x');
    fs.writeFileSync(path.join(dir, '.hidden'), 'x');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'p.md'), 'x');
    fs.writeFileSync(path.join(dir, 'real.md'), 'x');
    expect((await listFolder(dir)).map((f) => f.rel)).toEqual(['real.md']);
  });

  it('없는 폴더는 빈 배열(never-throw)', async () => {
    await expect(listFolder(path.join(dir, 'nope'))).resolves.toEqual([]);
  });

  it('내용 해시는 같은 내용이면 같고 다르면 다르다', async () => {
    const a = path.join(dir, 'a'); const b = path.join(dir, 'b'); const c = path.join(dir, 'c');
    fs.writeFileSync(a, 'same'); fs.writeFileSync(b, 'same'); fs.writeFileSync(c, 'other');
    expect(await hashFile(a)).toBe(await hashFile(b));
    expect(await hashFile(a)).not.toBe(await hashFile(c));
  });
});
