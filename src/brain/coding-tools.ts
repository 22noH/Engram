import * as fs from 'fs';
import * as path from 'path';
import { WebToolDef } from './web-tools';

// 코딩 도구루프(스펙 §4). web-tools와 같은 꼴 — provider 중립 스키마 + never-throw 실행기.
// 파일 I/O 기계만 담당하고, 쓰기 허용 판정은 주입받은 guard(=fence.assertCodingWrite)가 한다.
export const MAX_CODING_ITERATIONS = 30; // 코딩은 여러 파일을 고치므로 채팅(8)보다 높게

// 쓰기 허용 판정(막히면 throw). agent-layer가 fence.assertCodingWrite를 바인딩해 주입.
export type WriteGuard = (absPath: string) => void;

const READ_CHAR_LIMIT = 50_000;
const GLOB_LIMIT = 200;
const GREP_LIMIT = 100;
const LINE_CLIP = 200;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', 'build', 'out', '.venv', '__pycache__', '.cache', '.turbo']);

export const CODING_TOOL_DEFS: WebToolDef[] = [
  { name: 'Read', description: 'Read a text file in the working directory. Returns its content (truncated if large).',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path (relative to the working directory)' } }, required: ['path'] } },
  { name: 'Write', description: 'Create or overwrite a file with the given content. Only allowed within writable paths.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'Edit', description: 'Replace an exact, unique occurrence of old_string with new_string in a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'Glob', description: 'List files under the working directory matching a glob pattern (e.g. src/**/*.ts).',
    parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Grep', description: 'Search file contents under the working directory for a regex; returns matching lines.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Optional subdirectory to limit the search' } }, required: ['pattern'] } },
];

// 도구 실행 — never-throw. 실패는 에러 텍스트로 되먹임.
export async function executeCodingTool(name: string, input: unknown, cwd: string, guard: WriteGuard, signal: AbortSignal): Promise<string> {
  try {
    if (signal.aborted) return 'aborted';
    const arg = (input ?? {}) as Record<string, unknown>;
    switch (name) {
      case 'Read': return readFile(cwd, arg);
      case 'Write': return writeFile(cwd, arg, guard);
      case 'Edit': return editFile(cwd, arg, guard);
      case 'Glob': return glob(cwd, arg, signal);
      case 'Grep': return grep(cwd, arg, signal);
      default: return `coding tool error: unknown tool "${name}"`;
    }
  } catch (e) {
    return `coding tool error: ${String(e)}`;
  }
}

// cwd 안으로 정규화 + 심링크/정션 실제 경로까지 cwd 안인지 확인. 밖이면 null.
// 텍스트 정규화만으론 cwd 안의 심링크가 밖을 가리켜도 통과하는데(fs가 실제 대상을 따라감) realpath로 막는다.
function resolveWithin(cwd: string, p: string): string | null {
  const abs = path.resolve(cwd, p);
  if (!within(abs, cwd)) return null; // 빠른 텍스트 차단
  let realTarget = abs;
  let realCwd = cwd;
  try { realTarget = fs.realpathSync(abs); } catch { /* 미존재 경로 등 → abs로 판정(각 도구가 not-a-file 처리) */ }
  try { realCwd = fs.realpathSync(cwd); } catch { /* cwd 자체 미존재는 각 도구에서 처리 */ }
  return within(realTarget, realCwd) ? abs : null;
}
function within(target: string, base: string): boolean {
  const t = norm(target), b = norm(base);
  return t === b || t.startsWith(b + '/');
}
// Windows만 대소문자 무시. 리눅스/맥은 대소문자 구분이라 접어버리면 격리가 헐거워진다.
function norm(p: string): string {
  const s = path.normalize(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function readFile(cwd: string, arg: Record<string, unknown>): string {
  if (typeof arg.path !== 'string') return 'Read error: path(string) required';
  const abs = resolveWithin(cwd, arg.path);
  if (!abs) return `Read error: path outside working directory: ${arg.path}`;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `Read error: not a file: ${arg.path}`;
  const text = fs.readFileSync(abs, 'utf8');
  return text.length > READ_CHAR_LIMIT ? text.slice(0, READ_CHAR_LIMIT) + '\n… (truncated)' : text;
}

function writeFile(cwd: string, arg: Record<string, unknown>, guard: WriteGuard): string {
  if (typeof arg.path !== 'string' || typeof arg.content !== 'string') return 'Write error: path(string) and content(string) required';
  const abs = path.resolve(cwd, arg.path);
  try { guard(abs); } catch (e) { return `Write blocked: ${String(e)}`; }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, arg.content, 'utf8');
  return `wrote ${arg.path} (${arg.content.length} chars)`;
}

function editFile(cwd: string, arg: Record<string, unknown>, guard: WriteGuard): string {
  if (typeof arg.path !== 'string' || typeof arg.old_string !== 'string' || typeof arg.new_string !== 'string')
    return 'Edit error: path, old_string, new_string (all strings) required';
  const abs = path.resolve(cwd, arg.path);
  try { guard(abs); } catch (e) { return `Edit blocked: ${String(e)}`; } // 가드 먼저 — 못 쓰는 파일은 읽지도 않음
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `Edit error: not a file: ${arg.path}`;
  const text = fs.readFileSync(abs, 'utf8');
  const parts = text.split(arg.old_string);
  if (parts.length === 1) return `Edit error: old_string not found in ${arg.path}`;
  if (parts.length > 2) return `Edit error: old_string not unique in ${arg.path} (${parts.length - 1} matches) — add more surrounding context`;
  fs.writeFileSync(abs, parts.join(arg.new_string), 'utf8');
  return `edited ${arg.path}`;
}

function glob(cwd: string, arg: Record<string, unknown>, signal: AbortSignal): string {
  if (typeof arg.pattern !== 'string') return 'Glob error: pattern(string) required';
  const re = globToRegExp(arg.pattern);
  const out: string[] = [];
  walk(cwd, cwd, signal, (rel) => { if (out.length < GLOB_LIMIT && re.test(rel)) out.push(rel); });
  return out.length ? out.join('\n') : '(no matches)';
}

function grep(cwd: string, arg: Record<string, unknown>, signal: AbortSignal): string {
  if (typeof arg.pattern !== 'string') return 'Grep error: pattern(string) required';
  let re: RegExp;
  try { re = new RegExp(arg.pattern); } catch { return 'Grep error: invalid regex'; }
  const base = typeof arg.path === 'string' ? resolveWithin(cwd, arg.path) : cwd;
  if (!base) return 'Grep error: path outside working directory';
  const out: string[] = [];
  walk(base, cwd, signal, (rel, abs) => {
    if (out.length >= GREP_LIMIT) return;
    let content: string;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { return; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && out.length < GREP_LIMIT; i++) {
      if (re.test(lines[i])) out.push(`${rel}:${i + 1}:${lines[i].slice(0, LINE_CLIP)}`);
    }
  });
  return out.length ? out.join('\n') : '(no matches)';
}

// cwd 하위 재귀 walk(상대 posix 경로). node_modules/.git 등은 건너뜀. signal 관통.
function walk(dir: string, cwd: string, signal: AbortSignal, onFile: (rel: string, abs: string) => void): void {
  if (signal.aborted) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (signal.aborted) return;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs, cwd, signal, onFile); }
    else if (e.isFile()) onFile(path.relative(cwd, abs).replace(/\\/g, '/'), abs);
  }
}

// 최소 glob → RegExp. **/ = 0개 이상 폴더, ** = 아무거나, * = 슬래시 제외, ? = 한 글자.
// ponytail: 완전한 glob 아님(중괄호 확장 등 미지원) — 필요해지면 라이브러리로.
function globToRegExp(pattern: string): RegExp {
  const esc = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) { re += '(?:.*/)?'; i += 3; }
    else if (pattern.startsWith('**', i)) { re += '.*'; i += 2; }
    else if (pattern[i] === '*') { re += '[^/]*'; i++; }
    else if (pattern[i] === '?') { re += '[^/]'; i++; }
    else { re += esc(pattern[i]); i++; }
  }
  return new RegExp('^' + re + '$');
}
