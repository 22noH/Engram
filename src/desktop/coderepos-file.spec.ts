import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setAlias, removeAlias, setSearchRoots } from './coderepos-file';
import { loadCodeRepos } from '../agent-layer/coderepos';

describe('coderepos-file', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cr-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('setAlias: 추가·덮어쓰기, trim, 빈 값 false', () => {
    expect(setAlias(tmp, ' engram ', 'C:\\Src\\Engram')).toBe(true);
    expect(loadCodeRepos(tmp).aliases.engram).toBe('C:\\Src\\Engram');
    expect(setAlias(tmp, '', 'C:\\x')).toBe(false);
    expect(setAlias(tmp, 'a', '  ')).toBe(false);
  });
  it('removeAlias 멱등 + searchRoots 보존', () => {
    setAlias(tmp, 'a', 'C:\\a');
    setSearchRoots(tmp, ['C:\\Src']);
    removeAlias(tmp, 'a');
    removeAlias(tmp, 'a');
    expect(loadCodeRepos(tmp)).toEqual({ aliases: {}, searchRoots: ['C:\\Src'] });
  });
  it("alias '__proto__'는 거짓 성공 대신 false, removeAlias는 상속 프로퍼티로 헛 저장 안 함", () => {
    expect(setAlias(tmp, '__proto__', 'C:\\x')).toBe(false);
    removeAlias(tmp, '__proto__');
    expect(fs.existsSync(path.join(tmp, 'coderepos.json'))).toBe(false);
  });

  it('깨진 파일이면 골격에서 시작', () => {
    fs.writeFileSync(path.join(tmp, 'coderepos.json'), '{깨진');
    setSearchRoots(tmp, ['C:\\Src']);
    expect(loadCodeRepos(tmp).searchRoots).toEqual(['C:\\Src']);
  });
});
