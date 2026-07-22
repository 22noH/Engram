import { classifyCommand, formatSetup, formatStatus, KNOWN_COMMANDS, USAGE } from './server-cli';
import type { ServerStatus, SetupResult } from './edge/server-admin';

// server-cli.ts는 require.main 가드로 import 시 main()을 발화하지 않는다(직접 실행 시에만) —
// 그래서 여기선 순수 함수(classifyCommand·formatStatus·formatSetup)와 USAGE 텍스트만 검증한다.
// argv 실행/종료코드까지 보려면 프로세스 스폰이 필요한데, 그건 build 산출물 스모크(Task 5) 몫.

describe('server-cli: classifyCommand(argv 디스패치 분류)', () => {
  it('undefined·--help·-h → help', () => {
    expect(classifyCommand(undefined)).toBe('help');
    expect(classifyCommand('--help')).toBe('help');
    expect(classifyCommand('-h')).toBe('help');
  });

  it('구현된 명령(setup·status) → known-implemented', () => {
    expect(classifyCommand('setup')).toBe('known-implemented');
    expect(classifyCommand('status')).toBe('known-implemented');
  });

  it('알려졌지만 아직 미구현(user·group·config·preset·start·service) → known-pending', () => {
    for (const cmd of ['user', 'group', 'config', 'preset', 'start', 'service']) {
      expect(classifyCommand(cmd)).toBe('known-pending');
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
