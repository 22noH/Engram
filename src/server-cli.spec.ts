import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classifyCommand, formatConfigView, formatGroupList, formatPresetExport, formatSetup,
  formatStatus, formatUserList, formatUserReset, handleConfig, handleGroup, handlePreset,
  handleService, handleUser, KNOWN_COMMANDS, USAGE,
} from './server-cli';
import type {
  ConfigView, Group, PresetExportResult, ServerStatus, SetupResult, UserListItem, UserResetResult,
} from './edge/server-admin';
import { PathResolver } from './pal/path-resolver';
import { AccountStore } from './edge/auth/account-store';
import { GroupStore } from './edge/auth/group-store';

// server-cli.ts는 require.main 가드로 import 시 main()을 발화하지 않는다(직접 실행 시에만) —
// 그래서 여기선 순수 함수(classifyCommand·formatStatus·formatSetup·formatXxx)와 USAGE 텍스트,
// 그리고 handleXxx(argv 서브디스패치, tmp 데이터 디렉터리에 실제 스토어 IO)를 검증한다.
// server-admin.ts 쪽 핵심 로직 커버리지는 server-admin.spec.ts가 담당 — 여기는 CLI 계층
// (argv 파싱·포맷·exitCode)만 확인한다(house rule: 중복 없이 각 층 책임만).

describe('server-cli: classifyCommand(argv 디스패치 분류)', () => {
  it('undefined·--help·-h → help', () => {
    expect(classifyCommand(undefined)).toBe('help');
    expect(classifyCommand('--help')).toBe('help');
    expect(classifyCommand('-h')).toBe('help');
  });

  it('구현된 명령(setup·status·user·group·config·preset·start·service) → known-implemented', () => {
    for (const cmd of ['setup', 'status', 'user', 'group', 'config', 'preset', 'start', 'service']) {
      expect(classifyCommand(cmd)).toBe('known-implemented');
    }
  });

  it('알 수 없는 명령 → unknown', () => {
    expect(classifyCommand('bogus')).toBe('unknown');
    expect(classifyCommand('')).toBe('unknown');
  });
});

describe('server-cli: USAGE', () => {
  it('계획된 명령 전부를 나열한다', () => {
    for (const cmd of KNOWN_COMMANDS) {
      expect(USAGE).toContain(cmd);
    }
  });
});

describe('server-cli: formatStatus', () => {
  it('heartbeat null → "없음" 표기, listening 예/아니오 반영', () => {
    const s: ServerStatus = {
      lastHeartbeatMs: null, chatBytes: 0, knowledgeBytes: 0, memberCount: 0, channelCount: 1, listening: false,
    };
    const out = formatStatus(s);
    expect(out).toContain('없음');
    expect(out).toContain('아니오');
  });

  it('heartbeat 있음·listening true 반영, 바이트 단위 표기', () => {
    const s: ServerStatus = {
      lastHeartbeatMs: 1700000000000, chatBytes: 2048, knowledgeBytes: 5 * 1024 * 1024,
      memberCount: 3, channelCount: 2, listening: true,
    };
    const out = formatStatus(s);
    expect(out).toContain('예');
    expect(out).toContain('3명');
    expect(out).toContain('2개');
    expect(out).toMatch(/2\.0 KB/);
    expect(out).toMatch(/5\.0 MB/);
  });
});

describe('server-cli: formatSetup', () => {
  it('alreadyConfigured=true면 코드 없이 안내만', () => {
    const r: SetupResult = { code: null, alreadyConfigured: true, consoleUrl: 'http://localhost:47800/admin' };
    const out = formatSetup(r);
    expect(out).toContain('이미 설정');
    expect(out).toContain('http://localhost:47800/admin');
  });

  it('신규 코드가 있으면 코드와 콘솔 주소를 함께 출력', () => {
    const r: SetupResult = { code: 'abc123', alreadyConfigured: false, consoleUrl: 'http://localhost:47800/admin' };
    const out = formatSetup(r);
    expect(out).toContain('abc123');
    expect(out).toContain('http://localhost:47800/admin');
  });
});

describe('server-cli: formatUserList/formatUserReset/formatGroupList/formatConfigView/formatPresetExport', () => {
  it('formatUserList: 빈 목록·항목 있는 목록', () => {
    expect(formatUserList([])).toContain('없습니다');
    const items: UserListItem[] = [{ id: 'u1', loginId: 'kim', displayName: 'Kim', role: 'owner', status: 'active' }];
    const out = formatUserList(items);
    expect(out).toContain('kim');
    expect(out).toContain('owner');
    expect(out).toContain('active');
  });

  it('formatUserReset: ok=true면 임시 비밀번호를 노출, ok=false면 메시지만', () => {
    const ok: UserResetResult = { ok: true, message: '발급됨', tempPassword: 'abcdefghij' };
    expect(formatUserReset(ok)).toContain('abcdefghij');
    const fail: UserResetResult = { ok: false, message: '계정을 찾을 수 없습니다: x' };
    const out = formatUserReset(fail);
    expect(out).toContain('찾을 수 없습니다');
    expect(out).not.toContain('undefined');
  });

  it('formatGroupList: 빈 목록·항목 있는 목록(멤버/권한/채널 카운트 반영)', () => {
    expect(formatGroupList([])).toContain('없습니다');
    const groups: Group[] = [{
      id: 'g1', name: 'Engineers', memberIds: ['a', 'b'], permissions: ['wiki.approve'], channelIds: ['dev'],
      createdAt: new Date().toISOString(),
    }];
    const out = formatGroupList(groups);
    expect(out).toContain('Engineers');
    expect(out).toContain('멤버 2명');
    expect(out).toContain('wiki.approve');
    expect(out).toContain('채널 1개');
  });

  it('formatConfigView: key 생략 시 전체, 지정 시 그 한 줄만', () => {
    const c: ConfigView = { port: 47800, bind: '127.0.0.1', retention: { mode: 'unlimited' }, autoCompact: true, codingMode: 'auto' };
    const all = formatConfigView(c);
    expect(all).toContain('port: 47800');
    expect(all).toContain('bind: 127.0.0.1');
    expect(all).toContain('retention: unlimited');
    expect(all).toContain('coding: auto');
    const onlyPort = formatConfigView(c, 'port');
    expect(onlyPort.trim()).toBe('port: 47800');
  });

  it('formatConfigView: count/days retention은 mode:value로 표시', () => {
    const c: ConfigView = { port: 1, bind: '127.0.0.1', retention: { mode: 'count', value: 5 }, autoCompact: false, codingMode: 'off' };
    expect(formatConfigView(c)).toContain('retention: count:5');
  });

  it('formatPresetExport: 경로·name·endpoint를 출력', () => {
    const r: PresetExportResult = { ok: true, message: 'ok', path: 'C:\\data\\preset.json', preset: { name: 'Engram Server', endpoint: 'ws://127.0.0.1:47800' } };
    const out = formatPresetExport(r);
    expect(out).toContain('C:\\data\\preset.json');
    expect(out).toContain('Engram Server');
    expect(out).toContain('ws://127.0.0.1:47800');
  });
});

describe('server-cli: handleUser/handleGroup/handleConfig/handlePreset(argv 서브디스패치)', () => {
  let dir: string;
  let paths: PathResolver;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-server-cli-'));
    paths = new PathResolver(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('handleUser', () => {
    it('하위 명령 없음 → 사용법·exitCode 1', () => {
      const r = handleUser([], paths);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('사용법');
    });

    it('approve/suspend/reset-password: id 누락 → exitCode 1', () => {
      expect(handleUser(['approve'], paths).exitCode).toBe(1);
      expect(handleUser(['suspend'], paths).exitCode).toBe(1);
      expect(handleUser(['reset-password'], paths).exitCode).toBe(1);
    });

    it('list → exitCode 0', () => {
      const r = handleUser(['list'], paths);
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain('없습니다');
    });

    it('approve: 존재하지 않는 id → exitCode 1', () => {
      const r = handleUser(['approve', 'no-such-id'], paths);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('찾을 수 없습니다');
    });

    it('approve: pending 계정 승인 성공 → exitCode 0', () => {
      const accounts = new AccountStore(paths.getStateDir());
      const created = accounts.createPassword('kim', 'pw12345', 'Kim', { role: 'member', status: 'pending' });
      const r = handleUser(['approve', created.id], paths);
      expect(r.exitCode).toBe(0);
      expect(accounts.get(created.id)?.status).toBe('active');
    });

    it('reset-password: 성공하면 출력에 임시 비밀번호가 보인다', () => {
      const accounts = new AccountStore(paths.getStateDir());
      const created = accounts.createPassword('lee', 'pw12345', 'Lee', { role: 'member', status: 'active' });
      const r = handleUser(['reset-password', created.id], paths);
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain('임시 비밀번호');
    });
  });

  describe('handleGroup', () => {
    it('create: 이름 누락 → exitCode 1', () => {
      expect(handleGroup(['create'], paths).exitCode).toBe(1);
    });

    it('create → list 왕복', () => {
      expect(handleGroup(['create', 'Engineers'], paths).exitCode).toBe(0);
      const r = handleGroup(['list'], paths);
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain('Engineers');
    });

    it('set-perms: 잘못된 권한 → exitCode 1', () => {
      const g = new GroupStore(paths.getStateDir()).create('X');
      const r = handleGroup(['set-perms', g.id, 'wiki.approve,bogus.perm'], paths);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain('알 수 없는 권한');
    });

    it('set-perms: 유효한 권한(콤마 구분) → exitCode 0', () => {
      const g = new GroupStore(paths.getStateDir()).create('Y');
      const r = handleGroup(['set-perms', g.id, 'wiki.approve, wiki.edit'], paths);
      expect(r.exitCode).toBe(0);
    });

    it('delete: 존재하지 않는 id → exitCode 1', () => {
      expect(handleGroup(['delete', 'no-such-id'], paths).exitCode).toBe(1);
    });
  });

  describe('handleConfig', () => {
    it('get: key 생략 → 전체, exitCode 0', () => {
      const r = handleConfig(['get'], paths);
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain('port:');
      expect(r.output).toContain('coding:');
    });

    it('get: 알 수 없는 key → exitCode 1', () => {
      const r = handleConfig(['get', 'bogus'], paths);
      expect(r.exitCode).toBe(1);
    });

    it('set: 인자 부족 → exitCode 1', () => {
      expect(handleConfig(['set', 'port'], paths).exitCode).toBe(1);
    });

    it('set retention count:2 → get으로 왕복', () => {
      expect(handleConfig(['set', 'retention', 'count:2'], paths).exitCode).toBe(0);
      const r = handleConfig(['get', 'retention'], paths);
      expect(r.output).toContain('count:2');
    });

    it('set: 무효값 → exitCode 1', () => {
      expect(handleConfig(['set', 'bind', 'evil.example.com'], paths).exitCode).toBe(1);
    });
  });

  describe('handlePreset', () => {
    it('export → exitCode 0·preset.json 생성', () => {
      const r = handlePreset(['export'], paths);
      expect(r.exitCode).toBe(0);
      expect(fs.existsSync(path.join(paths.getConfigDir(), 'preset.json'))).toBe(true);
    });

    it('알 수 없는 하위 명령 → exitCode 1', () => {
      expect(handlePreset(['bogus'], paths).exitCode).toBe(1);
    });
  });

  // install/uninstall/start/stop/status는 실 OS 서비스·netsh를 건드리므로(관리자 권한 필요)
  // 여기서 실행하지 않는다 — edge/cli.gateway.spec.ts의 기존 service 테스트와 같은 결로 "알 수
  // 없는 하위 명령"만 확인한다(사용법 출력, 슈퍼바이저/netsh 미접촉). 실제 로직은
  // edge/server-service.spec.ts가 fake supervisor/netsh 주입으로 전부 커버한다.
  describe('handleService', () => {
    it('알 수 없는/빈 하위 명령 → 사용법·exitCode 1', async () => {
      const r1 = await handleService(['봉봉'], paths);
      expect(r1.exitCode).toBe(1);
      expect(r1.output).toContain('engram-server service');

      const r2 = await handleService([], paths);
      expect(r2.exitCode).toBe(1);
      expect(r2.output).toContain('engram-server service');
    });
  });
});
