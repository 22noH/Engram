import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadImportConfig, saveImportConfig } from '../knowledge-core/import/import.config';
import { loadWikiRemote, readWikiRemoteForm } from '../knowledge-core/wiki/wiki-remote.config';
import { readWikiRemoteFile } from '../desktop/wiki-remote-file';
import {
  applySettingChange, listSettings, planSettingChange, readSetting, SETTING_KEYS, type PlanContext,
} from './settings-registry';

// 세 경로(앱·AI·터미널)가 같은 파일을 읽고 쓰는지 / 위험 설정이 제대로 분류되는지 /
// 잘못된 감시 폴더가 거부되는지를 못박는다.

describe('설정 레지스트리(단일 출처)', () => {
  let data: string;
  let configDir: string;
  let watchable: string;
  let ctx: PlanContext;

  beforeEach(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-settings-'));
    configDir = path.join(data, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    watchable = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-inbox-'));
    ctx = {
      configDir,
      dataDir: data,
      repoRoot: path.join(data, '..', 'engram-repo-that-does-not-overlap'),
      homeDir: path.join(data, 'home'),
      env: { SystemRoot: 'C:\\Windows' },
    };
  });
  afterEach(() => {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(watchable, { recursive: true, force: true });
  });

  function set(key: string, value: string): string {
    const plan = planSettingChange(configDir, key, value, ctx);
    if (!plan.ok) throw new Error(plan.error);
    return applySettingChange(configDir, plan);
  }

  it('설정이 없어도 조회는 기본값으로 성공한다', () => {
    const views = listSettings(configDir);
    expect(views.map((v) => v.key)).toEqual(SETTING_KEYS);
    expect(readSetting(configDir, 'import.enabled')?.value).toBe('false');
    expect(readSetting(configDir, 'wiki.branch')?.value).toBe('main');
  });

  it('모르는 키는 조회·변경 모두 거부', () => {
    expect(readSetting(configDir, 'nope.nope')).toBeNull();
    const plan = planSettingChange(configDir, 'nope.nope', 'x', ctx);
    expect(plan).toMatchObject({ ok: false });
  });

  // ★핵심: 레지스트리로 쓴 값이 기존 로더(앱 설정창·백엔드가 읽는 그 함수)에 그대로 보인다.
  it('레지스트리로 쓴 폴더 설정을 앱/백엔드 로더가 그대로 읽는다', () => {
    set('import.folder', watchable);
    set('import.enabled', 'true');
    set('import.mode', 'raw');
    const cfg = loadImportConfig(configDir);
    expect(cfg).toMatchObject({ folder: path.resolve(watchable), enabled: true, mode: 'raw', publish: 'propose' });
  });

  it('앱 설정창이 쓴 값을 레지스트리가 그대로 읽는다(반대 방향도 같은 파일)', () => {
    saveImportConfig(configDir, { enabled: true, folder: watchable, publish: 'propose' });
    expect(readSetting(configDir, 'import.enabled')?.value).toBe('true');
    expect(readSetting(configDir, 'import.folder')?.value).toBe(watchable);
  });

  it('위키 원격은 knowledge-core 로더와 desktop 폼 리더가 같은 값을 본다', () => {
    set('wiki.remote', 'https://example.com/wiki.git');
    set('wiki.branch', 'trunk');
    set('wiki.syncIntervalSec', '120');
    expect(loadWikiRemote(configDir, {})).toEqual({
      remote: 'https://example.com/wiki.git', branch: 'trunk', syncIntervalSec: 120,
    });
    // desktop/wiki-remote-file.ts는 이제 재수출일 뿐 — 앱 설정창이 보는 값도 동일하다.
    expect(readWikiRemoteFile(configDir)).toEqual(readWikiRemoteForm(configDir));
    expect(readWikiRemoteFile(configDir).branch).toBe('trunk');
  });

  it('한 키를 바꿔도 같은 파일의 다른 키는 보존된다', () => {
    set('wiki.remote', 'git@example.com:me/wiki.git');
    set('wiki.syncIntervalSec', '30');
    expect(readWikiRemoteForm(configDir).remote).toBe('git@example.com:me/wiki.git');
    expect(readWikiRemoteForm(configDir).syncIntervalSec).toBe(30);
  });

  describe('위험도 분류', () => {
    it('위키 git 원격 변경은 위험(다른 저장소로 위키가 통째로 새어나갈 수 있다)', () => {
      const plan = planSettingChange(configDir, 'wiki.remote', 'https://evil.example/x.git', ctx);
      expect(plan).toMatchObject({ ok: true, risk: 'danger' });
      expect(plan.ok && plan.reason).toContain('evil.example');
    });

    it('"바로 게시"로 전환은 위험(사람 승인 우회) — "승인함으로"는 안전', () => {
      expect(planSettingChange(configDir, 'import.publish', 'direct', ctx)).toMatchObject({ risk: 'danger' });
      saveImportConfig(configDir, { publish: 'direct' });
      expect(planSettingChange(configDir, 'import.publish', 'propose', ctx)).toMatchObject({ risk: 'safe' });
    });

    it('폴더 경로·정리 방식·주기는 안전(그냥 허용)', () => {
      expect(planSettingChange(configDir, 'import.folder', watchable, ctx)).toMatchObject({ risk: 'safe' });
      expect(planSettingChange(configDir, 'import.mode', 'raw', ctx)).toMatchObject({ risk: 'safe' });
      expect(planSettingChange(configDir, 'import.enabled', 'true', ctx)).toMatchObject({ risk: 'safe' });
      expect(planSettingChange(configDir, 'wiki.syncIntervalSec', '90', ctx)).toMatchObject({ risk: 'safe' });
    });

    it('같은 값이면 unchanged — 승인 대화상자를 띄울 이유가 없다', () => {
      set('wiki.remote', 'https://example.com/w.git');
      expect(planSettingChange(configDir, 'wiki.remote', 'https://example.com/w.git', ctx))
        .toMatchObject({ ok: true, unchanged: true });
    });
  });

  describe('감시 폴더 경로 검증(승인으로도 못 뚫는 하드 거부)', () => {
    const err = (key: string, v: string, c: PlanContext): string => {
      const p = planSettingChange(configDir, key, v, c);
      return p.ok ? '' : p.error;
    };

    it('시스템 디렉터리 거부', () => {
      const sys = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc';
      expect(err('import.folder', sys, ctx)).toMatch(/system directory|does not exist/);
    });

    it('엔그램 데이터 폴더(자기 위키) 거부 — 자기 자신을 다시 먹는 순환', () => {
      expect(err('import.folder', data, ctx)).toContain('data folder');
      expect(err('import.folder', configDir, ctx)).toContain('data folder');
    });

    it('엔그램 설치 폴더 거부', () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-repo-'));
      const c = { ...ctx, repoRoot: repo };
      expect(err('import.folder', repo, c)).toContain('installation folder');
      fs.rmSync(repo, { recursive: true, force: true });
    });

    it('상대경로·없는 폴더·파일 거부', () => {
      expect(err('import.folder', 'inbox', ctx)).toContain('absolute');
      expect(err('import.folder', path.join(watchable, 'nope'), ctx)).toContain('does not exist');
      const f = path.join(watchable, 'a.txt');
      fs.writeFileSync(f, 'x');
      expect(err('import.folder', f, ctx)).toContain('not a folder');
    });

    it('홈 폴더 전체는 거부가 아니라 위험(승인 필요)', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-home-'));
      const plan = planSettingChange(configDir, 'import.folder', home, { ...ctx, homeDir: home });
      expect(plan).toMatchObject({ ok: true, risk: 'danger' });
      fs.rmSync(home, { recursive: true, force: true });
    });

    it('빈 값은 감시 끄기로 허용', () => {
      expect(planSettingChange(configDir, 'import.folder', 'none', ctx)).toMatchObject({ ok: true, to: '' });
    });
  });

  describe('값 검증', () => {
    it('허용 밖 값·범위 밖 숫자·엉터리 원격은 거부', () => {
      expect(planSettingChange(configDir, 'import.mode', 'weird', ctx)).toMatchObject({ ok: false });
      expect(planSettingChange(configDir, 'import.publish', 'nuke', ctx)).toMatchObject({ ok: false });
      expect(planSettingChange(configDir, 'wiki.syncIntervalSec', '0', ctx)).toMatchObject({ ok: false });
      expect(planSettingChange(configDir, 'import.maxFilesPerRun', '9999', ctx)).toMatchObject({ ok: false });
      expect(planSettingChange(configDir, 'wiki.remote', 'not a url', ctx)).toMatchObject({ ok: false });
    });

    it('true/on/1 같은 표현을 모두 받아준다', () => {
      set('import.enabled', 'on');
      expect(loadImportConfig(configDir).enabled).toBe(true);
      set('import.enabled', 'no');
      expect(loadImportConfig(configDir).enabled).toBe(false);
    });
  });

  it('두뇌 설정은 읽기 전용 — 변경 시도는 거부하고 앱으로 안내', () => {
    fs.writeFileSync(path.join(configDir, 'brains.json'), JSON.stringify({ default: 'claude', brains: { claude: {}, codex: {} } }));
    expect(readSetting(configDir, 'brain.default')?.value).toBe('claude');
    expect(readSetting(configDir, 'brain.list')?.value).toBe('claude, codex');
    expect(readSetting(configDir, 'brain.default')?.readOnly).toBe(true);
    const plan = planSettingChange(configDir, 'brain.default', 'codex', ctx);
    expect(plan).toMatchObject({ ok: false });
    expect(!plan.ok && plan.error).toContain('read-only');
  });
});
