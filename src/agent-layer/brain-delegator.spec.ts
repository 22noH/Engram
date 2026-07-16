import { BrainDelegator } from './brain-delegator';
import { BrainProvider, BrainResult, CompleteOpts } from '../brain/brain.port';

// opts를 기록하는 가짜 두뇌(깊이 1 검증: 일꾼은 opts.delegate 없이 불려야 함).
function fakeBrain(result: Partial<BrainResult>): BrainProvider & { calls: CompleteOpts[] } {
  const calls: CompleteOpts[] = [];
  return {
    calls,
    complete: async (_p: string, _c?: (t: string) => void, opts?: CompleteOpts) => {
      calls.push(opts ?? {});
      return { text: 'worker-answer', costUsd: 0.5, isError: false, ...result } as BrainResult;
    },
  };
}

describe('BrainDelegator', () => {
  it('이름 지정 두뇌를 resolve해 complete(task)를 delegate 없이 부른다(깊이 1)', async () => {
    const worker = fakeBrain({});
    const d = new BrainDelegator((name) => (name === 'ollama' ? worker : (fakeBrain({}) as BrainProvider)), () => ['ollama', 'claude']);
    const out = await d.handle().run('ollama', '리뷰해줘');
    expect(out).toBe('worker-answer');
    expect(worker.calls).toHaveLength(1);
    expect(worker.calls[0].delegate).toBeUndefined(); // 재위임 불가
    expect(d.spentUsd()).toBeCloseTo(0.5);
  });

  it('미지 두뇌는 에러 텍스트(throw 아님)', async () => {
    const d = new BrainDelegator(() => fakeBrain({}) as BrainProvider, () => ['ollama']);
    const out = await d.handle().run('gpt', 't');
    expect(out).toContain('unknown brain');
    expect(out).toContain('ollama');
  });

  it('일꾼 isError는 에러 텍스트', async () => {
    const d = new BrainDelegator(() => fakeBrain({ isError: true, raw: 'boom' }) as BrainProvider, () => ['x']);
    expect(await d.handle().run('x', 't')).toContain('failed');
  });

  it('handle()마다 비용 카운터 리셋 + brains 목록 노출', () => {
    const d = new BrainDelegator(() => fakeBrain({}) as BrainProvider, () => ['a', 'b']);
    expect(d.handle().brains).toEqual(['a', 'b']);
  });
});
