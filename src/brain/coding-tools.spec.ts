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
});
