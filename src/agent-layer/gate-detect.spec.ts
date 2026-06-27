import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectGate } from './gate-detect';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-gate-')); }

describe('detectGate', () => {
  it('package.json test/build/typecheck 스크립트 감지', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest', build: 'tsc', typecheck: 'tsc --noEmit' } }));
    expect(detectGate(dir)).toEqual({ test: 'npm test', build: 'npm run build', typecheck: 'npm run typecheck' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('npm 기본 placeholder test("no test specified")는 무시', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(detectGate(dir).test).toBe('');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('typecheck 스크립트 없고 tsconfig.json 있으면 tsc --noEmit', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: {} }));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    expect(detectGate(dir).typecheck).toBe('npx tsc --noEmit');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('아무것도 없으면 전부 빈 문자열(하드 게이트 없음)', () => {
    const dir = tmp();
    expect(detectGate(dir)).toEqual({ test: '', build: '', typecheck: '' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
