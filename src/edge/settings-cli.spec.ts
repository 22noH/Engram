import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadImportConfig } from '../knowledge-core/import/import.config';
import { readWikiRemoteForm } from '../knowledge-core/wiki/wiki-remote.config';
import { runSettingsCommand } from './settings-cli';
import type { PlanContext } from './settings-registry';

describe('engram config(터미널 경로)', () => {
  let data: string;
  let configDir: string;
  let inbox: string;
  let ctx: PlanContext;

  beforeEach(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cfgcli-'));
    configDir = path.join(data, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cfgcli-inbox-'));
    ctx = { configDir, dataDir: data, repoRoot: '', homeDir: path.join(data, 'home'), env: {} };
  });
  afterEach(() => {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(inbox, { recursive: true, force: true });
  });

  const run = (...args: string[]): { output: string; exitCode: number } =>
    runSettingsCommand(args, configDir, ctx);

  it('인자 없으면 사용법(성공 종료)', () => {
    const r = run();
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('engram config');
  });

  it('get은 전체 목록을 보여준다', () => {
    const r = run('get');
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('import.folder');
    expect(r.output).toContain('(not set)');
    expect(r.output).toContain('read-only'); // brain.* 는 조회만
  });

  it('get <key>는 값+설명+허용값', () => {
    const r = run('get', 'import.mode');
    expect(r.output).toContain('import.mode = ai');
    expect(r.output).toContain('allowed: ai | raw');
  });

  it('모르는 key는 exitCode 1', () => {
    expect(run('get', 'nope').exitCode).toBe(1);
    expect(run('set', 'nope', 'x').exitCode).toBe(1);
  });

  it('set이 설정 파일에 실제로 반영된다(앱/백엔드가 읽는 그 파일)', () => {
    const r = run('set', 'import.enabled', 'true');
    expect(r.exitCode).toBe(0);
    expect(loadImportConfig(configDir).enabled).toBe(true);
    expect(r.output).toContain('import.enabled');
  });

  it('공백 있는 폴더 경로도 따옴표 없이 받는다', () => {
    const spaced = path.join(inbox, 'my notes');
    fs.mkdirSync(spaced);
    const r = run('set', 'import.folder', ...spaced.split(' '));
    expect(r.exitCode).toBe(0);
    expect(loadImportConfig(configDir).folder).toBe(spaced);
  });

  // ★터미널은 사람이 직접 친 명령 = 사람의 결정. 그래도 왜 위험한지 반드시 알려준다.
  it('위험 설정도 터미널에선 실행되지만 경고를 함께 낸다', () => {
    const r = run('set', 'wiki.remote', 'https://example.com/w.git');
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('경고:');
    expect(readWikiRemoteForm(configDir).remote).toBe('https://example.com/w.git');
  });

  it('안전 설정엔 경고가 붙지 않는다', () => {
    expect(run('set', 'import.mode', 'raw').output).not.toContain('경고');
  });

  it('잘못된 값은 파일을 건드리지 않고 실패한다', () => {
    const before = loadImportConfig(configDir);
    const r = run('set', 'import.publish', 'nuke');
    expect(r.exitCode).toBe(1);
    expect(loadImportConfig(configDir)).toEqual(before);
  });

  it('같은 값이면 변경 없음으로 끝난다', () => {
    run('set', 'import.mode', 'raw');
    expect(run('set', 'import.mode', 'raw').output).toContain('변경 없음');
  });

  it('값 없이 set하면 실패', () => {
    expect(run('set', 'import.mode').exitCode).toBe(1);
  });

  it('읽기 전용 키 변경은 앱으로 안내', () => {
    const r = run('set', 'brain.default', 'codex');
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('read-only');
  });
});
