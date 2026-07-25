import { describe, it, expect, beforeEach } from 'vitest';
import { loadConnections, saveConnections, addConnection, isLocalEndpoint } from './connections';

beforeEach(() => localStorage.clear());

describe('connections store', () => {
  it('seeds a Local default when empty', () => {
    const s = loadConnections();
    expect(s.connections).toHaveLength(1);
    expect(s.connections[0].id).toBe('local');
    expect(s.defaultConnId).toBe('local');
    expect(s.connections[0].endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:/);
  });
  it('persists and reloads', () => {
    const s = addConnection(loadConnections(), 'Work', 'ws://192.168.0.9:47800');
    saveConnections(s);
    const r = loadConnections();
    expect(r.connections.map((c) => c.name)).toEqual(['Local', 'Work']);
  });
  it('addConnection is pure (does not mutate input)', () => {
    const a = loadConnections();
    const b = addConnection(a, 'Work', 'ws://x:1');
    expect(a.connections).toHaveLength(1);
    expect(b.connections).toHaveLength(2);
  });
  it('프리셋이 있으면 preset이 기본 연결', async () => {
    vi.resetModules();
    vi.doMock('./config', () => ({ WS_URL: 'ws://127.0.0.1:47800', PRESET: { name: 'Team Server', endpoint: 'ws://10.0.0.5:47800' } }));
    const mod = await import('./connections');
    const s = mod.loadConnections();
    expect(s.connections.map((c) => c.id)).toEqual(['preset', 'local']);
    expect(s.connections[0].name).toBe('Team Server');
    expect(s.connections[0].endpoint).toBe('ws://10.0.0.5:47800');
    expect(s.defaultConnId).toBe('preset');
    vi.doUnmock('./config');
    vi.resetModules();
  });
});

// 입력바 배지 게이트(모델·노력은 로컬 연결에서만) — 원격은 서버 설정을 그대로 따른다.
// 판정은 두뇌 계층 isLoopback(src/edge/mcp/mcp-http.ts) 관례와 같은 루프백 집합으로 한다.
describe('isLocalEndpoint — 루프백 판정', () => {
  it.each(['ws://127.0.0.1:47800', 'ws://localhost:47800', 'ws://[::1]:47800', 'wss://127.0.0.1:1', 'http://localhost:3000'])(
    '%s는 로컬', (e) => expect(isLocalEndpoint(e)).toBe(true),
  );
  it.each(['ws://10.0.0.5:47800', 'ws://192.168.0.9:47800', 'wss://engram.example.com', 'ws://127.0.0.1.evil.com:80'])(
    '%s는 원격', (e) => expect(isLocalEndpoint(e)).toBe(false),
  );
  it('빈 값·깨진 값은 원격 취급(안전측 — 배지를 숨긴다)', () => {
    expect(isLocalEndpoint(undefined)).toBe(false);
    expect(isLocalEndpoint('')).toBe(false);
    expect(isLocalEndpoint('나는 URL이 아니다')).toBe(false);
  });
});
