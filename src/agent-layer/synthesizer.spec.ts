import { Synthesizer } from './synthesizer';
import { FakeBrain } from '../brain/fake-brain';

it('블랙보드를 종합 프롬프트로 두뇌에 넘겨 답을 만든다', async () => {
  const s = new Synthesizer(new FakeBrain({ text: '종합결론', costUsd: 0, isError: false }));
  const out = await s.synthesize('Q', { Brand: 'a', Trend: 'b' });
  expect(out).toBe('종합결론');
});

it('빈 블랙보드는 안내 문자열(기본 en)', async () => {
  const s = new Synthesizer(new FakeBrain());
  const out = await s.synthesize('Q', {});
  expect(out).toBe('No expert input to synthesize.');
});

it('ENGRAM_LANG=ko면 한국어 안내 문자열', async () => {
  process.env.ENGRAM_LANG = 'ko';
  try {
    const s = new Synthesizer(new FakeBrain());
    const out = await s.synthesize('Q', {});
    expect(out).toBe('전문가 기여가 없어 종합할 내용이 없습니다.');
  } finally {
    delete process.env.ENGRAM_LANG;
  }
});

it('synthesizer prompt: english + interactive directive', async () => {
  let captured = '';
  const brain = { complete: async (p: string) => { captured = p; return { text: 'x', costUsd: 0 }; } };
  const s = new Synthesizer(brain as any);
  await s.synthesize('q', { Manager: 'op' });
  expect(/[가-힣]/.test(captured)).toBe(false);
  expect(captured).toContain("Respond in the language of the user's latest message.");
});
