import { Synthesizer } from './synthesizer';
import { FakeBrain } from '../brain/fake-brain';

it('블랙보드를 종합 프롬프트로 두뇌에 넘겨 답을 만든다', async () => {
  const s = new Synthesizer(new FakeBrain({ text: '종합결론', costUsd: 0, isError: false }));
  const out = await s.synthesize('Q', { Brand: 'a', Trend: 'b' });
  expect(out).toBe('종합결론');
});

it('빈 블랙보드는 안내 문자열', async () => {
  const s = new Synthesizer(new FakeBrain());
  const out = await s.synthesize('Q', {});
  expect(out).toContain('기여');
});
