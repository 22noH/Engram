import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CODING_TOOL_DEFS, executeCodingTool, MAX_CODING_ITERATIONS, WriteGuard } from './coding-tools';

const NO_ABORT = { aborted: false } as AbortSignal;
const allow: WriteGuard = () => {}; // 항상 허용
const run = (name: string, input: unknown, cwd: string, guard: WriteGuard = allow) =>
  executeCodingTool(name, input, cwd, guard, NO_ABORT);

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ctools-'));
}

describe('CODING_TOOL_DEFS', () => {
  it('5종(Read/Write/Edit/Glob/Grep)을 노출', () => {
    expect(CODING_TOOL_DEFS.map((d) => d.name)).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
    expect(MAX_CODING_ITERATIONS).toBeGreaterThan(8);
  });
});

describe('executeCodingTool (never-throw)', () => {
  it('Write는 파일을 만들고 부모 폴더도 생성', async () => {
    const dir = tmp();
    try {
      const out = await run('Write', { path: 'sub/a.txt', content: 'hello' }, dir);
      expect(out).toContain('wrote');
      expect(fs.readFileSync(path.join(dir, 'sub/a.txt'), 'utf8')).toBe('hello');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('Read는 내용을 반환, cwd 밖이면 에러 텍스트', async () => {
    const dir = tmp();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'body');
      expect(await run('Read', { path: 'a.txt' }, dir)).toBe('body');
      expect(await run('Read', { path: '../../etc/hosts' }, dir)).toContain('outside working directory');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('Edit는 정확 1곳만 치환, 없으면/여러곳이면 에러 텍스트', async () => {
    const dir = tmp();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'x foo y foo z');
      expect(await run('Edit', { path: 'a.txt', old_string: 'nope', new_string: 'q' }, dir)).toContain('not found');
      expect(await run('Edit', { path: 'a.txt', old_string: 'foo', new_string: 'q' }, dir)).toContain('not unique');
      expect(await run('Edit', { path: 'a.txt', old_string: 'x foo y', new_string: 'X' }, dir)).toContain('edited');
      expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('X foo z');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('가드가 막으면 Write/Edit는 파일을 안 건드리고 에러 텍스트(never-throw)', async () => {
    const dir = tmp();
    const deny: WriteGuard = (p) => { throw new Error(`denied ${p}`); };
    try {
      const out = await run('Write', { path: 'a.txt', content: 'x' }, dir, deny);
      expect(out).toContain('blocked');
      expect(fs.existsSync(path.join(dir, 'a.txt'))).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('Glob는 cwd 하위 매치, Grep는 매치 라인(파일:줄) 반환', async () => {
    const dir = tmp();
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src/a.ts'), 'const x = 1;\nconst y = 2;');
      fs.writeFileSync(path.join(dir, 'src/b.js'), 'ignore');
      expect(await run('Glob', { pattern: 'src/**/*.ts' }, dir)).toContain('src/a.ts');
      expect(await run('Glob', { pattern: 'src/**/*.ts' }, dir)).not.toContain('b.js');
      const g = await run('Grep', { pattern: 'const y' }, dir);
      expect(g).toContain('src/a.ts:2:');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('오염 인자·미지 도구는 에러 텍스트(throw 아님)', async () => {
    const dir = tmp();
    try {
      expect(await run('Write', { path: 1 }, dir)).toContain('required');
      expect(await run('Nope', {}, dir)).toContain('unknown tool');
      expect(await run('Read', null, dir)).toContain('required');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('cwd 안의 정션/심링크가 밖을 가리켜도 Read/Grep은 막는다(유출 차단)', async () => {
    const dir = tmp();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
    let made = true;
    // 정션(dir)은 Windows에서 권한 없이도 생성됨. 리눅스/맥은 일반 심링크로 폴백.
    try { fs.symlinkSync(outside, path.join(dir, 'link'), 'junction'); } catch { made = false; }
    try {
      if (made) {
        expect(await run('Read', { path: 'link/secret.txt' }, dir)).toContain('outside working directory');
        expect(await run('Grep', { pattern: 'SECRET', path: 'link' }, dir)).toContain('outside working directory');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('cwd 안의 정션이 밖을 가리켜도 Write/Edit는 막고 대상을 안 만든다(자기수정 차단)', async () => {
    const dir = tmp();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-woutside-'));
    let made = true;
    try { fs.symlinkSync(outside, path.join(dir, 'link'), 'junction'); } catch { made = false; }
    try {
      if (made) {
        expect(await run('Write', { path: 'link/evil.txt', content: 'x' }, dir)).toContain('outside working directory');
        expect(fs.existsSync(path.join(outside, 'evil.txt'))).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('cwd 밖 경로로의 Write는 가드와 무관하게 막는다(자동모드 이탈 방지)', async () => {
    const dir = tmp();
    try {
      // allow 가드(항상 허용)라도 cwd 밖은 막혀야 한다.
      expect(await run('Write', { path: '../escape.txt', content: 'x' }, dir)).toContain('outside working directory');
      expect(fs.existsSync(path.join(dir, '..', 'escape.txt'))).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('cwd 안 "깨진 심링크"가 밖을 가리켜도 Write는 막는다(POSIX 우회 봉쇄)', async () => {
    const dir = tmp();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-dangle-'));
    // 밖의 아직 없는 대상을 가리키는 심링크. Windows 파일심링크는 권한 필요 → 실패시 스킵.
    let made = true;
    try { fs.symlinkSync(path.join(outside, 'nope.txt'), path.join(dir, 'link')); } catch { made = false; }
    try {
      if (made) {
        expect(await run('Write', { path: 'link', content: 'x' }, dir)).toContain('outside working directory');
        expect(fs.existsSync(path.join(outside, 'nope.txt'))).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
