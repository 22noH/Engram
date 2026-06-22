import { chunkBody } from './chunker';

describe('chunkBody', () => {
  it('빈 본문은 빈 배열', () => {
    expect(chunkBody('   \n  ')).toEqual([]);
  });

  it('짧은 본문은 1청크', () => {
    expect(chunkBody('한 문단입니다.')).toEqual(['한 문단입니다.']);
  });

  it('문단(빈 줄)을 maxChars 한도로 누적해 나눈다', () => {
    const p = 'x'.repeat(80);
    const body = [p, p, p].join('\n\n'); // 3문단 × 80자
    const chunks = chunkBody(body, 100); // 한도 100 → 문단당 1청크 근처
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 100 || !c.includes('\n\n'))).toBe(true);
  });

  it('여러 짧은 문단은 한 청크로 합쳐진다', () => {
    const chunks = chunkBody('가\n\n나\n\n다', 100);
    expect(chunks).toEqual(['가\n\n나\n\n다']);
  });
});
