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
    const h = d.handle();
    const out = await h.run('ollama', '리뷰해줘');
    expect(out).toBe('worker-answer');
    expect(worker.calls).toHaveLength(1);
    expect(worker.calls[0].delegate).toBeUndefined(); // 재위임 불가
    expect(h.spentUsd()).toBeCloseTo(0.5);
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

  it('resolve가 던져도 에러 텍스트(never-throw 자립)', async () => {
    // 미지원 provider 등으로 프로필 빌드가 동기 throw해도 삼켜야 한다(계약 §I3).
    const d = new BrainDelegator(() => { throw new Error('bad profile'); }, () => ['x']);
    expect(await d.handle().run('x', 't')).toContain('threw');
  });

  it('비용은 handle()별로 격리된다(동시 대화 간섭 없음) + brains 노출', async () => {
    const d = new BrainDelegator(() => fakeBrain({}) as BrainProvider, () => ['a', 'b']);
    const h1 = d.handle();
    expect(h1.brains).toEqual(['a', 'b']);
    await h1.run('a', 't');
    expect(h1.spentUsd()).toBeCloseTo(0.5);
    const h2 = d.handle(); // 새 세션 = 0에서 시작(h1과 독립)
    expect(h2.spentUsd()).toBe(0);
    expect(h1.spentUsd()).toBeCloseTo(0.5); // h1은 영향 없음
  });

  // 최종 리뷰 Important: 자기위임 데드락 차단. handle(selfName)이 selfName을 목록에서 빼야
  // 지휘자가 ask_brain으로 자기 자신을 호출해 같은 세마포어 permit을 재진입하는 사고를 막는다.
  describe('selfName 제외(자기위임 데드락 차단)', () => {
    it('handle(selfName) → brains 목록에서 selfName만 빠지고 나머지는 유지', () => {
      const d = new BrainDelegator(() => fakeBrain({}) as BrainProvider, () => ['claude-A', 'ollama', 'claude-A2']);
      expect(d.handle('claude-A').brains).toEqual(['ollama', 'claude-A2']);
    });

    it('selfName 미지정(기본 지휘자) → 전 목록 그대로(회귀 0)', () => {
      const d = new BrainDelegator(() => fakeBrain({}) as BrainProvider, () => ['claude-A', 'ollama']);
      expect(d.handle().brains).toEqual(['claude-A', 'ollama']);
      expect(d.handle(undefined).brains).toEqual(['claude-A', 'ollama']);
    });

    it('run()으로 selfName을 호출하면 unknown brain 에러 — resolve가 아예 안 불려 자기 인스턴스로 재진입하지 않는다', async () => {
      let resolveCalled = false;
      const d = new BrainDelegator(
        () => { resolveCalled = true; return fakeBrain({}) as BrainProvider; },
        () => ['claude-A', 'ollama'],
      );
      const out = await d.handle('claude-A').run('claude-A', 'task');
      expect(out).toBe('delegate error: unknown brain "claude-A" (available: ollama)'); // 안내 목록에 claude-A 없음
      expect(resolveCalled).toBe(false); // 데드락의 핵심 방지점: complete() 재진입 자체가 없다
    });

    it('run()으로 selfName이 아닌 다른 이름은 정상 위임된다(과도한 차단 없음)', async () => {
      const worker = fakeBrain({});
      const d = new BrainDelegator((name) => (name === 'ollama' ? worker : (fakeBrain({}) as BrainProvider)), () => ['claude-A', 'ollama']);
      const out = await d.handle('claude-A').run('ollama', 'task');
      expect(out).toBe('worker-answer');
      expect(worker.calls).toHaveLength(1);
    });
  });
});
