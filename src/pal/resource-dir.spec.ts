import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveResourceFile, resolveResourceDir } from './resource-dir';
import { findRepoRoot } from './repo-root';

describe('resource-dir', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-res-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('ENGRAM_DATA_DIR에 파일이 있으면 그 경로를 반환한다', () => {
    fs.mkdirSync(path.join(tmp, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'prompts', 'triage.md'), '오버라이드');
    const p = resolveResourceFile('prompts/triage.md', { ENGRAM_DATA_DIR: tmp });
    expect(p).toBe(path.join(tmp, 'prompts', 'triage.md'));
  });

  it('ENGRAM_DATA_DIR에 파일이 없으면 레포 루트로 폴백한다', () => {
    const p = resolveResourceFile('prompts/triage.md', { ENGRAM_DATA_DIR: tmp });
    expect(p).toBe(path.join(findRepoRoot(__dirname), 'prompts', 'triage.md'));
  });

  it('ENGRAM_DATA_DIR 미설정이면 레포 루트를 쓴다', () => {
    const p = resolveResourceFile('prompts/triage.md', {});
    expect(p).toBe(path.join(findRepoRoot(__dirname), 'prompts', 'triage.md'));
  });

  it('디렉토리 오버라이드: dataDir/personas가 있으면 그 폴더', () => {
    fs.mkdirSync(path.join(tmp, 'personas'), { recursive: true });
    expect(resolveResourceDir('personas', { ENGRAM_DATA_DIR: tmp })).toBe(path.join(tmp, 'personas'));
  });

  it('디렉토리 오버라이드: 없으면 레포 루트 폴백', () => {
    expect(resolveResourceDir('personas', { ENGRAM_DATA_DIR: tmp })).toBe(
      path.join(findRepoRoot(__dirname), 'personas'),
    );
  });
});
