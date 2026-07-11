import { describe, it, expect, beforeEach } from 'vitest';
import { loadConnections, saveConnections, addConnection } from './connections';

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
