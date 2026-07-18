import * as http from 'http';
import type { AddressInfo } from 'net';
import { defaultDataDir, parseHeadlessArgs, chooseMode } from './mcp-headless';

describe('defaultDataDir', () => {
  it('win32 — %APPDATA%\\Engram', () => {
    expect(defaultDataDir('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' })).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\Engram',
    );
  });

  it('win32 — APPDATA 미설정 시 homedir 기반 폴백(크래시 없이 안전한 기본값)', () => {
    const dir = defaultDataDir('win32', {});
    expect(dir.endsWith('Engram')).toBe(true);
    expect(dir).toContain('AppData');
  });

  it('darwin — ~/Library/Application Support/Engram', () => {
    const dir = defaultDataDir('darwin', {});
    expect(dir.endsWith(require('path').join('Library', 'Application Support', 'Engram'))).toBe(true);
  });

  it('linux(기타) — XDG_CONFIG_HOME/Engram', () => {
    expect(defaultDataDir('linux', { XDG_CONFIG_HOME: '/home/me/.config' })).toBe(
      require('path').join('/home/me/.config', 'Engram'),
    );
  });

  it('linux(기타) — XDG_CONFIG_HOME 미설정 시 ~/.config/Engram', () => {
    const dir = defaultDataDir('linux', {});
    expect(dir.endsWith(require('path').join('.config', 'Engram'))).toBe(true);
  });
});

describe('parseHeadlessArgs', () => {
  const dummyDataDirEnv = { ENGRAM_DATA_DIR: '/tmp/engram-test-data' };

  it('--data-dir 인자가 최우선', () => {
    const { dataDir } = parseHeadlessArgs(['node', 'x.js', '--data-dir', '/custom/dir'], dummyDataDirEnv);
    expect(dataDir).toBe('/custom/dir');
  });

  it('--data-dir 없으면 ENGRAM_DATA_DIR env', () => {
    const { dataDir } = parseHeadlessArgs(['node', 'x.js'], dummyDataDirEnv);
    expect(dataDir).toBe('/tmp/engram-test-data');
  });

  it('둘 다 없으면 OS 기본 데이터 경로', () => {
    const { dataDir } = parseHeadlessArgs(['node', 'x.js'], {});
    expect(dataDir.endsWith('Engram')).toBe(true);
  });

  it('--write-mode 플래그 — 있으면 true, 없으면 false', () => {
    expect(parseHeadlessArgs(['node', 'x.js', '--write-mode'], {}).writeMode).toBe(true);
    expect(parseHeadlessArgs(['node', 'x.js'], {}).writeMode).toBe(false);
  });

  it('--port 인자가 최우선', () => {
    const { port } = parseHeadlessArgs(['node', 'x.js', '--port', '9999'], { ENGRAM_PORT: '8888' });
    expect(port).toBe(9999);
  });

  it('--port 없으면 ENGRAM_PORT env', () => {
    const { port } = parseHeadlessArgs(['node', 'x.js'], { ENGRAM_PORT: '8888' });
    expect(port).toBe(8888);
  });

  it('둘 다 없으면 DEFAULT_CHAT_PORT(47800)', () => {
    const { port } = parseHeadlessArgs(['node', 'x.js'], {});
    expect(port).toBe(47800);
  });

  it('--port 값이 잘못됐으면(비숫자·범위밖) env로 폴백, env도 잘못되면 기본값', () => {
    expect(parseHeadlessArgs(['node', 'x.js', '--port', 'xyz'], { ENGRAM_PORT: '7000' }).port).toBe(7000);
    expect(parseHeadlessArgs(['node', 'x.js'], { ENGRAM_PORT: '-1' }).port).toBe(47800);
  });
});

describe('chooseMode', () => {
  it('GET / 이 200 + {ok:true} 응답 → "bridge"', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await chooseMode(port)).toBe('bridge');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('연결 거부(듣는 곳 없음) → "core"', async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    expect(await chooseMode(port)).toBe('core');
  });

  it('200이지만 {ok:true}가 아닌 응답 → "core"(다른 서비스가 그 포트를 쓰고 있을 가능성)', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ not: 'engram' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await chooseMode(port)).toBe('core');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('200 + 비JSON 본문 → "core"(never-throw)', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not json');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await chooseMode(port)).toBe('core');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('행(hung) 서버 — 접속은 받되 영원히 무응답 → 타임아웃 후 "core"(멈춘 상주에 안 매달림)', async () => {
    // 요청 핸들러가 아무것도 안 함 = 응답을 영원히 안 보내는 서버(8a 교훈의 "스톨" 클래스).
    const server = http.createServer(() => { /* never respond */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // 테스트 속도를 위해 짧은 타임아웃 — 프로덕션 기본값(2000ms)과 같은 코드 경로.
      expect(await chooseMode(port, 300)).toBe('core');
    } finally {
      // 행 중인 소켓이 close를 막지 않게 강제 정리.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
