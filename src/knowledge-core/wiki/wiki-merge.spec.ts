import { makeBrainBodyMerger } from './wiki-merge';

const tmpl = 'MERGE\nOURS:\n{{OURS}}\nTHEIRS:\n{{THEIRS}}';

describe('makeBrainBodyMerger', () => {
  it('두뇌 출력을 반환(프롬프트에 두 본문 주입)', async () => {
    let seen = '';
    const brain = { complete: async (p: string) => { seen = p; return { text: 'MERGED', isError: false }; } };
    const merger = makeBrainBodyMerger(brain, tmpl);
    expect(await merger('AAA', 'BBB')).toBe('MERGED');
    expect(seen).toContain('AAA');
    expect(seen).toContain('BBB');
  });
  it('isError → null(union 폴백 유도)', async () => {
    const brain = { complete: async () => ({ text: 'x', isError: true }) };
    expect(await makeBrainBodyMerger(brain, tmpl)('a', 'b')).toBeNull();
  });
  it('빈 출력 → null', async () => {
    const brain = { complete: async () => ({ text: '   ', isError: false }) };
    expect(await makeBrainBodyMerger(brain, tmpl)('a', 'b')).toBeNull();
  });
});
