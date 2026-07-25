import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectCodex, codexInstallCommand, addCodexProfile } from './codex';
import type { Runner } from './claude-detect';

describe('detectCodex (PATH + 잘 알려진 위치)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-codex-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('PATH의 codex가 바로 되면 command=codex', async () => {
    const run: Runner = async (cmd) => {
      if (cmd === 'codex') return { code: 0, stdout: 'codex-cli 0.20.0\n' };
      throw new Error('unexpected cmd ' + cmd);
    };
    expect(await detectCodex(run, {}, 'win32')).toEqual({ installed: true, version: 'codex-cli 0.20.0', command: 'codex' });
  });

  it('PATH 미스 + npm 전역(%APPDATA%\\npm\\codex.cmd) 존재 → 절대경로 command', async () => {
    const appData = path.join(dir, 'AppData', 'Roaming');
    const cmdPath = path.join(appData, 'npm', 'codex.cmd');
    fs.mkdirSync(path.dirname(cmdPath), { recursive: true });
    fs.writeFileSync(cmdPath, '');
    const run: Runner = async (cmd) => {
      if (cmd === 'codex') throw new Error('ENOENT');
      if (cmd === cmdPath) return { code: 0, stdout: '0.21.0\n' };
      throw new Error('unexpected cmd ' + cmd);
    };
    expect(await detectCodex(run, { USERPROFILE: dir, APPDATA: appData }, 'win32')).toEqual({
      installed: true, version: '0.21.0', command: cmdPath,
    });
  });

  it('앞 후보가 존재하지만 --version 실패하면 다음 후보로 계속', async () => {
    const appData = path.join(dir, 'AppData', 'Roaming');
    const bad = path.join(appData, 'npm', 'codex.cmd');
    const good = path.join(dir, '.local', 'bin', 'codex.exe');
    for (const p of [bad, good]) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); }
    const run: Runner = async (cmd) => {
      if (cmd === 'codex') throw new Error('ENOENT');
      if (cmd === bad) return { code: 1, stdout: '' };
      if (cmd === good) return { code: 0, stdout: '0.22.0\n' };
      throw new Error('unexpected cmd ' + cmd);
    };
    expect((await detectCodex(run, { USERPROFILE: dir, APPDATA: appData }, 'win32')).command).toBe(good);
  });

  it('전부 실패하면 installed:false (command는 codex로 안전 폴백)', async () => {
    const run: Runner = async () => { throw new Error('ENOENT'); };
    expect(await detectCodex(run, { USERPROFILE: dir, APPDATA: path.join(dir, 'AppData', 'Roaming') }, 'win32')).toEqual({
      installed: false, version: null, command: 'codex',
    });
  });

  it('darwin/linux 후보(~/.local/bin, /usr/local/bin, /opt/homebrew/bin)도 탐색한다', async () => {
    const localBin = path.join(dir, '.local', 'bin', 'codex');
    fs.mkdirSync(path.dirname(localBin), { recursive: true });
    fs.writeFileSync(localBin, '');
    const run: Runner = async (cmd) => {
      if (cmd === 'codex') throw new Error('ENOENT');
      if (cmd === localBin) return { code: 0, stdout: '0.23.0\n' };
      throw new Error('unexpected cmd ' + cmd);
    };
    expect((await detectCodex(run, { HOME: dir }, 'darwin')).command).toBe(localBin);
  });

  it('설치 안내 명령은 npm 전역 설치', () => {
    expect(codexInstallCommand()).toBe('npm install -g @openai/codex');
  });
});

describe('addCodexProfile (원클릭 등록)', () => {
  let tmp: string;
  const readBrains = (): { default: string; brains: Record<string, Record<string, unknown>> } =>
    JSON.parse(fs.readFileSync(path.join(tmp, 'brains.json'), 'utf8'));
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-codex-add-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('brains.json이 없으면 만들고 codex-cli 프로필을 넣는다(default는 claude 유지)', () => {
    addCodexProfile(tmp, 'codex', 'C:/x/codex.cmd');
    const cfg = readBrains();
    expect(cfg.brains.codex).toEqual({ provider: 'codex-cli', cli: 'C:/x/codex.cmd' });
    expect(cfg.default).toBe('claude');
  });

  it('탐지 경로가 PATH의 codex면 그대로 cli:codex', () => {
    addCodexProfile(tmp, 'codex', 'codex');
    expect(readBrains().brains.codex.cli).toBe('codex');
  });

  it('기존 프로필을 보존하고 codex만 병합한다', () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'brains.json'), JSON.stringify({ default: 'claude', brains: { claude: { provider: 'claude-cli' } } }));
    addCodexProfile(tmp, 'codex', 'codex');
    const cfg = readBrains();
    expect(cfg.brains.claude).toEqual({ provider: 'claude-cli' });
    expect(cfg.brains.codex.provider).toBe('codex-cli');
  });

  it('setDefault=true면 기본 두뇌를 codex로 바꾼다', () => {
    addCodexProfile(tmp, 'codex', 'codex', true);
    expect(readBrains().default).toBe('codex');
  });

  it('같은 이름으로 다시 추가하면 덮어쓴다(이름 충돌 = 덮어쓰기)', () => {
    addCodexProfile(tmp, 'codex', 'codex');
    addCodexProfile(tmp, 'codex', 'D:/other/codex.cmd');
    expect(readBrains().brains.codex.cli).toBe('D:/other/codex.cmd');
  });

  it('다른 이름이면 프로필이 따로 쌓인다', () => {
    addCodexProfile(tmp, 'codex', 'codex');
    addCodexProfile(tmp, 'codex-work', 'D:/work/codex.cmd');
    expect(Object.keys(readBrains().brains).sort()).toEqual(['codex', 'codex-work']);
  });
});
