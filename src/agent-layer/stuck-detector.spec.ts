import { StuckDetector } from './stuck-detector';

describe('StuckDetector(K=3)', () => {
  it('연속 무변화 3회면 stuck', () => {
    const d = new StuckDetector(3);
    expect(d.observe('0:0')).toBe(false); // 1회
    expect(d.observe('0:0')).toBe(false); // 2회
    expect(d.observe('0:0')).toBe(true);  // 3회 → stuck
  });
  it('진전하면 리셋', () => {
    const d = new StuckDetector(3);
    d.observe('0:0'); d.observe('0:0');
    expect(d.observe('1:0')).toBe(false); // 진전 → 리셋
    expect(d.observe('1:0')).toBe(false);
    expect(d.observe('1:0')).toBe(true);
  });
});
