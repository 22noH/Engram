import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installedPluginVersion, ownVersion, stalePluginNotice } from './plugin-version';

// 2026-07-27 실사고: 플러그인이 0.0.7에 3일 넘게 멈춰 있었다. 서드파티 마켓플레이스는 자동 갱신이
// 기본으로 켜지지 않아(이 머신의 다른 5개 전부 필드 없음·몇 달째 그대로) 설치한 사람은 그 버전에
// 영원히 머문다. MCP 서버는 npx -y라 늘 최신이므로, 최신인 우리가 낡은 플러그인을 알아채 알린다.
describe('plugin-version', () => {
  const tmps: string[] = [];
  function makeHome(version?: string, key = 'engram@engram'): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-plug-'));
    tmps.push(home);
    if (version !== undefined) {
      const dir = path.join(home, '.claude', 'plugins');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'installed_plugins.json'),
        JSON.stringify({ version: 2, plugins: { [key]: [{ scope: 'user', version }] } }),
      );
    }
    return home;
  }
  afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

  it('설치된 플러그인 버전을 읽는다', () => {
    expect(installedPluginVersion({ USERPROFILE: makeHome('0.0.7') } as NodeJS.ProcessEnv)).toBe('0.0.7');
  });

  it('파일이 없거나 engram 항목이 없으면 null(조용히)', () => {
    expect(installedPluginVersion({ USERPROFILE: makeHome() } as NodeJS.ProcessEnv)).toBeNull();
    expect(installedPluginVersion({ USERPROFILE: makeHome('1.0.0', 'other@mkt') } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("version이 'unknown'이면 못 읽은 것으로 본다(공식 플러그인들이 그렇게 기록된다)", () => {
    expect(installedPluginVersion({ USERPROFILE: makeHome('unknown') } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('우리 버전은 package.json에서 읽힌다', () => {
    expect(ownVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('플러그인이 더 낡았으면 두 줄 명령이 담긴 안내를 준다', () => {
    const msg = stalePluginNotice({ USERPROFILE: makeHome('0.0.1') } as NodeJS.ProcessEnv);
    expect(msg).toContain('0.0.1');
    expect(msg).toContain('claude plugin marketplace update engram');
    expect(msg).toContain('claude plugin update engram@engram');
  });

  // 모르는 건 말하지 않는다 — 오탐으로 겁주면 다음부터 아무도 안 읽는다.
  it('같거나 최신이면 아무 말도 안 한다', () => {
    const ours = ownVersion()!;
    expect(stalePluginNotice({ USERPROFILE: makeHome(ours) } as NodeJS.ProcessEnv)).toBeNull();
    expect(stalePluginNotice({ USERPROFILE: makeHome('99.0.0') } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('버전을 못 읽으면 아무 말도 안 한다', () => {
    expect(stalePluginNotice({ USERPROFILE: makeHome() } as NodeJS.ProcessEnv)).toBeNull();
    expect(stalePluginNotice({ USERPROFILE: makeHome('nonsense') } as NodeJS.ProcessEnv)).toBeNull();
  });
});
