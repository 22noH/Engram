import { describe, it, expect, beforeEach } from 'vitest';
import { loadDisplayName, saveDisplayName } from './display-name';

describe('display-name', () => {
  beforeEach(() => localStorage.clear());

  it('저장하고 로드에서 복원한다', () => {
    saveDisplayName('alice');
    expect(loadDisplayName()).toBe('alice');
  });

  it('미설정이면 빈 문자열', () => {
    expect(loadDisplayName()).toBe('');
  });
});
