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
  it('addConnection: token을 저장하고 로드에서 복원한다', () => {
    const s = addConnection(loadConnections(), 'Remote', 'ws://r', 'tok');
    saveConnections(s);
    expect(loadConnections().connections.find((c) => c.name === 'Remote')?.token).toBe('tok');
  });
  it('addConnection: token 없으면 undefined(필드 미포함)', () => {
    const s = addConnection(loadConnections(), 'Plain', 'ws://p');
    expect(s.connections.find((c) => c.name === 'Plain')?.token).toBeUndefined();
  });
  it('loadConnections: LOCAL_TOKEN이 있으면 local 연결에 실린다(신규 시드)', () => {
    localStorage.clear();
    expect(loadConnections('injected').connections.find((c) => c.id === 'local')?.token).toBe('injected');
  });
  it('loadConnections: LOCAL_TOKEN이 있으면 기존 local 연결에도 패치된다', () => {
    saveConnections({ connections: [{ id: 'local', name: 'Local', endpoint: 'ws://x' }], defaultConnId: 'local' });
    expect(loadConnections('patched').connections.find((c) => c.id === 'local')?.token).toBe('patched');
  });
});
