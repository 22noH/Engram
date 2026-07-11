import { describe, it, expect, beforeEach } from 'vitest';
import { loadSessions, saveSessionFor, clearSessionFor } from './sessions';

describe('sessions', () => {
  beforeEach(() => localStorage.clear());
  it('저장·로드·삭제 왕복', () => {
    expect(loadSessions()).toEqual({});
    const m = saveSessionFor('c1', 'tok1');
    expect(m).toEqual({ c1: 'tok1' });
    expect(loadSessions()).toEqual({ c1: 'tok1' });
    expect(clearSessionFor('c1')).toEqual({});
  });
  it('손상 저장소 → 빈 맵', () => {
    localStorage.setItem('engram.sessions', '{bad');
    expect(loadSessions()).toEqual({});
  });
});
