import { ReaderAgent } from './reader-agent';
import { FakeBrain } from '../brain/fake-brain';
import { SearchResult } from '../knowledge-core/rag/rag.types';
import { InsightContext } from '../knowledge-core/insight/insight-context';
import { PathResolver } from '../pal/path-resolver';
import { PinoLogger } from '../pal/logger';
import { RagStore } from '../knowledge-core/rag/rag-store';
import { BrainDelegator } from './brain-delegator';
import { ChannelBrainResolver } from './channel-brain-resolver';
import { BrainProvider, BrainResult, CompleteOpts } from '../brain/brain.port';

const ragWith = (hits: { slug: string; title: string; text: string }[]): RagStore =>
  ({ search: async () => hits } as unknown as RagStore);
const brainEcho = (capture?: (p: string) => void) => ({
  complete: async (prompt: string) => { capture?.(prompt); return { text: '답', costUsd: 0, isError: false }; },
});

// RagStore의 search만 쓰는 최소 스텁.
function stubRag(results: SearchResult[]) {
  return { search: jest.fn(async () => results) } as any;
}
const logger = { error: jest.fn() } as any;

describe('ReaderAgent', () => {
  it('검색 결과를 컨텍스트로 brain에 넘기고 답+출처를 반환한다', async () => {
    const rag = stubRag([{ slug: 'a', title: 'A페이지', text: '본문', score: 1 }]);
    const reader = new ReaderAgent(rag, new FakeBrain({ text: '답이다', costUsd: 0, isError: false }), logger);
    const out = await reader.handle({ text: '질문', userId: 'default' });
    expect(rag.search).toHaveBeenCalledWith('질문', 5, 'default');
    expect(out).toContain('답이다');
    expect(out).toContain('Sources:');
    expect(out).toContain('A페이지');
    expect(out).toContain('(a)');
  });

  it('검색 결과가 없으면 경고 머리말을 붙이고 출처는 없다(기본 en)', async () => {
    const rag = stubRag([]);
    const reader = new ReaderAgent(rag, new FakeBrain({ text: '일반답', costUsd: 0, isError: false }), logger);
    const out = await reader.handle({ text: '질문', userId: 'default' });
    expect(out).toContain('No related content in the wiki');
    expect(out).not.toContain('Sources:');
  });

  it('brain이 isError면 실패 메시지를 반환한다(기본 en)', async () => {
    const rag = stubRag([{ slug: 'a', title: 'A', text: 'b', score: 1 }]);
    const reader = new ReaderAgent(rag, new FakeBrain({ text: '', costUsd: 0, isError: true }), logger);
    const out = await reader.handle({ text: '질문', userId: 'default' });
    expect(out).toContain('Answer generation failed');
  });

  it('예외가 나도 프로세스를 죽이지 않고 실패 메시지를 반환한다(기본 en)', async () => {
    const rag = { search: jest.fn(async () => { throw new Error('rag down'); }) } as any;
    const reader = new ReaderAgent(rag, new FakeBrain(), logger);
    const out = await reader.handle({ text: '질문', userId: 'default' });
    expect(out).toContain('Answer generation failed');
    expect(logger.error).toHaveBeenCalled();
  });

  it('onChunk로 머리말·본문·출처를 흘려보낸다(스트리밍, 기본 en)', async () => {
    const rag = stubRag([{ slug: 'a', title: 'A페이지', text: 'b', score: 1 }]);
    const reader = new ReaderAgent(rag, new FakeBrain({ text: '스트림답', costUsd: 0, isError: false }), logger);
    const chunks: string[] = [];
    const out = await reader.handle({ text: '질문', userId: 'default' }, (t) => chunks.push(t));
    const joined = chunks.join('');
    expect(joined).toContain('스트림답');
    expect(joined).toContain('Sources:');
    expect(out).toBe(joined);
  });

  it('isError + onChunk일 때 반환값 == 스트리밍 청크의 합(기본 en)', async () => {
    const rag = stubRag([{ slug: 'a', title: 'A페이지', text: 'b', score: 1 }]);
    const reader = new ReaderAgent(rag, new FakeBrain({ text: '', costUsd: 0, isError: true }), logger);
    const chunks: string[] = [];
    const out = await reader.handle({ text: '질문', userId: 'default' }, (t) => chunks.push(t));
    const joined = chunks.join('');
    expect(out).toBe(joined);
    expect(out).toContain('Answer generation failed');
  });

  it('ENGRAM_LANG=ko면 한국어 머리말/출처/실패 메시지', async () => {
    process.env.ENGRAM_LANG = 'ko';
    try {
      const rag0 = stubRag([]);
      const reader0 = new ReaderAgent(rag0, new FakeBrain({ text: '일반답', costUsd: 0, isError: false }), logger);
      const out0 = await reader0.handle({ text: '질문', userId: 'default' });
      expect(out0).toContain('⚠ 위키에 관련 내용 없음');

      const rag1 = stubRag([{ slug: 'a', title: 'A페이지', text: '본문', score: 1 }]);
      const reader1 = new ReaderAgent(rag1, new FakeBrain({ text: '답이다', costUsd: 0, isError: false }), logger);
      const out1 = await reader1.handle({ text: '질문', userId: 'default' });
      expect(out1).toContain('출처:');

      const rag2 = stubRag([{ slug: 'a', title: 'A', text: 'b', score: 1 }]);
      const reader2 = new ReaderAgent(rag2, new FakeBrain({ text: '', costUsd: 0, isError: true }), logger);
      const out2 = await reader2.handle({ text: '질문', userId: 'default' });
      expect(out2).toContain('답변 생성 실패');
    } finally {
      delete process.env.ENGRAM_LANG;
    }
  });
});

describe('ReaderAgent 인사이트 주입', () => {
  const insightLogger = new PinoLogger(new PathResolver(require('os').tmpdir()));

  it('onSources로 인용 slug를 노출한다', async () => {
    let slugs: string[] = [];
    const reader = new ReaderAgent(ragWith([{ slug: 's1', title: 'T', text: 'x' }]), brainEcho() as any, insightLogger);
    await reader.handle({ text: 'q', userId: 'default' }, undefined, (s) => { slugs = s; });
    expect(slugs).toEqual(['s1']);
  });

  it('InsightContext 주입 시 참고용 섹션을 프롬프트에 넣는다', async () => {
    let prompt = '';
    const ctx = { latest: async () => '(2026-06-28 기준) 도커 집중' } as unknown as InsightContext;
    const reader = new ReaderAgent(ragWith([]), brainEcho((p) => { prompt = p; }) as any, insightLogger, ctx);
    await reader.handle({ text: 'q', userId: 'default' });
    expect(prompt).toContain('User context for reference');
    expect(prompt).toContain('도커 집중');
  });

  it('InsightContext 없으면 참고용 섹션이 없다', async () => {
    let prompt = '';
    const reader = new ReaderAgent(ragWith([]), brainEcho((p) => { prompt = p; }) as any, insightLogger);
    await reader.handle({ text: 'q', userId: 'default' });
    expect(prompt).not.toContain('User context for reference');
  });
});

describe('ReaderAgent 직전 대화 주입(연속성)', () => {
  const logger2 = new PinoLogger(new PathResolver(require('os').tmpdir()));

  it('ConversationStore 주입 시 직전 대화 섹션이 프롬프트에 들어간다', async () => {
    let prompt = '';
    const convs = {
      recent: async () => [
        { ts: '2026-07-03T11:00:00Z', question: '코스피 요약해줘', answer: '웹 검색 권한이 없어 실시간 시세를 못 가져옵니다. 허용할까요?' },
      ],
    } as any;
    const reader = new ReaderAgent(ragWith([]), brainEcho((p) => { prompt = p; }) as any, logger2, undefined, convs);
    await reader.handle({ text: '1 웹검색허용', userId: 'ch-1' });
    expect(prompt).toContain('# Prior conversation');
    expect(prompt).toContain('코스피 요약해줘');
    expect(prompt).toContain('허용할까요?');
  });

  it('ConversationStore 없으면 직전 대화 섹션이 없다(기존 동작 유지)', async () => {
    let prompt = '';
    const reader = new ReaderAgent(ragWith([]), brainEcho((p) => { prompt = p; }) as any, logger2);
    await reader.handle({ text: 'q', userId: 'default' });
    expect(prompt).not.toContain('# Prior conversation');
  });

  it('recent()가 던져도 답변은 진행된다(연속성만 포기)', async () => {
    const convs = { recent: async () => { throw new Error('boom'); } } as any;
    const reader = new ReaderAgent(ragWith([]), brainEcho() as any, logger2, undefined, convs);
    const out = await reader.handle({ text: 'q', userId: 'default' });
    expect(out).not.toContain('답변 생성 실패');
  });

  it('긴 답변은 잘라서 주입한다(400자 클립)', async () => {
    let prompt = '';
    const convs = {
      recent: async () => [{ ts: '2026-07-03T11:00:00Z', question: 'q', answer: 'A'.repeat(1000) }],
    } as any;
    const reader = new ReaderAgent(ragWith([]), brainEcho((p) => { prompt = p; }) as any, logger2, undefined, convs);
    await reader.handle({ text: 'q2', userId: 'default' });
    expect(prompt).toContain('A'.repeat(400) + '…');
    expect(prompt).not.toContain('A'.repeat(401));
  });
});

it('reader prompt: english + interactive directive + chart contract', () => {
  const r = new ReaderAgent({} as any, {} as any, { error(){} } as any);
  const p = (r as any).buildPrompt('question?', [], '', []) as string;
  expect(/[가-힣]/.test(p)).toBe(false);
  expect(p).toContain("Respond in the language of the user's latest message.");
  expect(p).toContain('```chart');
});

describe('ReaderAgent 지휘자 배선(Phase 8d)', () => {
  const rag8d = { search: async () => [] } as any;
  const logger8d = { error: () => {}, log: () => {}, warn: () => {} } as any;
  // canDelegate=true=엔그램 하네스(지휘자 지원), false=CLI 두뇌(미지원).
  function recordingBrain(canDelegate = true) {
    const seen: { prompt: string; opts?: CompleteOpts }[] = [];
    const brain: BrainProvider = {
      canDelegate,
      complete: async (prompt: string, _c?: (t: string) => void, opts?: CompleteOpts) => {
        seen.push({ prompt, opts });
        return { text: 'ok', costUsd: 0, isError: false } as BrainResult;
      },
    };
    return { brain, seen };
  }
  const worker8d = { complete: async () => ({ text: 'w', costUsd: 0, isError: false } as BrainResult) } as BrainProvider;
  const msg8d = { text: '리뷰는 클로드로 해줘', userId: 'default' } as any;

  it('위임기 주입 + 두뇌가 위임지원이면 opts.delegate 전달 + conductor 프롬프트 포함', async () => {
    const { brain, seen } = recordingBrain(true);
    const delegator = new BrainDelegator(() => worker8d, () => ['claude', 'ollama']);
    const reader = new ReaderAgent(rag8d, brain, logger8d, undefined, undefined, delegator);
    await reader.handle(msg8d);
    expect(seen[0].opts?.delegate).toBeDefined();
    expect(seen[0].opts?.delegate?.brains).toEqual(['claude', 'ollama']);
    expect(seen[0].prompt).toContain('ask_brain'); // conductor 지침 포함
  });

  it('위임기 주입돼도 CLI 두뇌(canDelegate 미지원)면 지휘자 오프(회귀 — CLI 기본)', async () => {
    const { brain, seen } = recordingBrain(false);
    const delegator = new BrainDelegator(() => worker8d, () => ['claude', 'ollama']);
    const reader = new ReaderAgent(rag8d, brain, logger8d, undefined, undefined, delegator);
    await reader.handle(msg8d);
    expect(seen[0].opts?.delegate).toBeUndefined();
    expect(seen[0].prompt).not.toContain('ask_brain');
  });

  it('위임 가능한 두뇌가 없으면(brains []) 지휘자 오프', async () => {
    const { brain, seen } = recordingBrain(true);
    const delegator = new BrainDelegator(() => worker8d, () => []);
    const reader = new ReaderAgent(rag8d, brain, logger8d, undefined, undefined, delegator);
    await reader.handle(msg8d);
    expect(seen[0].opts?.delegate).toBeUndefined();
    expect(seen[0].prompt).not.toContain('ask_brain');
  });

  it('위임기 미주입 시 opts.delegate 미전달(회귀)', async () => {
    const { brain, seen } = recordingBrain(true);
    const reader = new ReaderAgent(rag8d, brain, logger8d);
    await reader.handle(msg8d);
    expect(seen[0].opts?.delegate).toBeUndefined();
    expect(seen[0].prompt).not.toContain('ask_brain');
  });

  // MCP-parity Task 4 리뷰 지적: 도구 사용 지침은 conductor 게이트와 무관하게 항상 프롬프트에 있어야 한다.
  const TOOL_USAGE_GUIDANCE_TEXT =
    'In a scheduled or automatic-execution context, only use tools that write externally';

  it('CLI 두뇌(canDelegate 없음)도 도구 사용 지침을 받는다(지휘자 오프여도)', async () => {
    const { brain, seen } = recordingBrain(false);
    const delegator = new BrainDelegator(() => worker8d, () => ['claude', 'ollama']);
    const reader = new ReaderAgent(rag8d, brain, logger8d, undefined, undefined, delegator);
    await reader.handle(msg8d);
    expect(seen[0].opts?.delegate).toBeUndefined(); // 지휘자는 여전히 오프(회귀)
    expect(seen[0].prompt).toContain(TOOL_USAGE_GUIDANCE_TEXT);
  });

  it('지휘자 켜진 두뇌 — 도구 사용 지침이 정확히 한 번만 등장한다(conductor 블록과 중복 없음)', async () => {
    const { brain, seen } = recordingBrain(true);
    const delegator = new BrainDelegator(() => worker8d, () => ['claude', 'ollama']);
    const reader = new ReaderAgent(rag8d, brain, logger8d, undefined, undefined, delegator);
    await reader.handle(msg8d);
    const prompt = seen[0].prompt;
    expect(prompt).toContain('ask_brain'); // conductor 블록은 여전히 포함
    const occurrences = prompt.split(TOOL_USAGE_GUIDANCE_TEXT).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('ReaderAgent 채널 두뇌 해소(Task 2, 스펙 §3.2)', () => {
  const rag = { search: async () => [] } as any;
  const logger = { error: () => {}, log: () => {}, warn: () => {} } as any;

  it('이벤트 brain 지정 시 해소된 두뇌의 complete가 불리고 기본 두뇌는 안 불림', async () => {
    const defaultCalls: string[] = [];
    const namedCalls: string[] = [];
    const defaultBrain: BrainProvider = { complete: async () => { defaultCalls.push('x'); return { text: '기본답', costUsd: 0, isError: false }; } };
    const namedBrain: BrainProvider = { complete: async () => { namedCalls.push('x'); return { text: '채널답', costUsd: 0, isError: false }; } };
    const resolver = new ChannelBrainResolver((name) => (name === 'qwen' ? namedBrain : defaultBrain), defaultBrain, logger);
    const reader = new ReaderAgent(rag, defaultBrain, logger, undefined, undefined, undefined, resolver);
    const out = await reader.handle({ text: 'q', userId: 'c1', brain: 'qwen' });
    expect(out).toContain('채널답');
    expect(namedCalls).toHaveLength(1);
    expect(defaultCalls).toHaveLength(0);
  });

  it('지휘자 게이트는 해소된(채널) 두뇌의 canDelegate 기준 — 기본은 미지원이어도 채널 두뇌가 지원하면 위임 켜짐', async () => {
    const defaultBrain: BrainProvider = { complete: async () => ({ text: 'x', costUsd: 0, isError: false }) }; // canDelegate 없음
    const seen: { opts?: CompleteOpts }[] = [];
    const namedBrain: BrainProvider = {
      canDelegate: true,
      complete: async (_p, _c, opts) => { seen.push({ opts }); return { text: 'ok', costUsd: 0, isError: false }; },
    };
    const worker = { complete: async () => ({ text: 'w', costUsd: 0, isError: false }) } as BrainProvider;
    const delegator = new BrainDelegator(() => worker, () => ['claude', 'qwen']);
    const resolver = new ChannelBrainResolver((name) => (name === 'qwen' ? namedBrain : defaultBrain), defaultBrain, logger);
    const reader = new ReaderAgent(rag, defaultBrain, logger, undefined, undefined, delegator, resolver);
    await reader.handle({ text: 'q', userId: 'c1', brain: 'qwen' });
    expect(seen[0].opts?.delegate).toBeDefined();
  });

  it('이벤트 brain 미지정이면 channelBrain 주입돼도 기본 두뇌 그대로(회귀 0)', async () => {
    const calls: string[] = [];
    const defaultBrain: BrainProvider = { complete: async () => { calls.push('x'); return { text: '기본답', costUsd: 0, isError: false }; } };
    const resolver = new ChannelBrainResolver(() => { throw new Error('불려선 안 됨'); }, defaultBrain, logger);
    const reader = new ReaderAgent(rag, defaultBrain, logger, undefined, undefined, undefined, resolver);
    const out = await reader.handle({ text: 'q', userId: 'c1' });
    expect(out).toContain('기본답');
    expect(calls).toHaveLength(1);
  });

  it('channelBrain 미주입(구식 DI) → 기존 동작 그대로(회귀 0)', async () => {
    const calls: string[] = [];
    const defaultBrain: BrainProvider = { complete: async () => { calls.push('x'); return { text: '기본답', costUsd: 0, isError: false }; } };
    const reader = new ReaderAgent(rag, defaultBrain, logger);
    const out = await reader.handle({ text: 'q', userId: 'c1', brain: 'qwen' }); // resolver 없으니 brain 필드는 무시
    expect(out).toContain('기본답');
    expect(calls).toHaveLength(1);
  });

  // 최종 리뷰 Important: 자기위임 데드락 회귀 테스트. 채널 두뇌가 이름 지정 인스턴스(canDelegate=true,
  // concurrency:1 세마포어를 통째로 감싸는 실 하네스 상황을 흉내)일 때, 모델이 자기 자신의 이름으로
  // ask_brain을 부르면 그 이름이 애초에 도구 설명/목록에 없어야 한다 — 있으면 자기 인스턴스의 complete()를
  // 재진입해 세마포어 permit이 영구 반환되지 않는 데드락에 빠진다(§요구사항, 8d의 module 주석이 경고한 바로 그 사고).
  it('자기위임 데드락 차단: 채널 두뇌 자신의 이름은 위임 목록에서 빠지고 나머지는 남는다', async () => {
    const cache = new Map<string, BrainProvider>();
    const seen: { opts?: CompleteOpts }[] = [];
    // BRAIN_NAME_RESOLVE와 동일한 결의 공유 캐시: 같은 이름 → 같은 인스턴스.
    const resolveByName = (name: string): BrainProvider => {
      if (!cache.has(name)) {
        cache.set(
          name,
          name === 'claude-B'
            ? { canDelegate: true, complete: async (_p, _c, opts) => { seen.push({ opts }); return { text: 'ok', costUsd: 0, isError: false }; } }
            : { complete: async () => ({ text: 'w', costUsd: 0, isError: false }) },
        );
      }
      return cache.get(name)!;
    };
    const delegator = new BrainDelegator(resolveByName, () => ['claude-B', 'ollama', 'gemma']);
    const defaultBrain: BrainProvider = { complete: async () => ({ text: '기본', costUsd: 0, isError: false }) };
    const resolver = new ChannelBrainResolver(resolveByName, defaultBrain, logger);
    const reader = new ReaderAgent(rag, defaultBrain, logger, undefined, undefined, delegator, resolver);
    // 채널 두뇌 이름이 'claude-B' — 이게 곧 지휘자 자신의 인스턴스 이름(resolveByName 공유).
    await reader.handle({ text: 'q', userId: 'c1', brain: 'claude-B' });
    expect(seen[0].opts?.delegate?.brains).toEqual(['ollama', 'gemma']); // 자기 이름 제외, 나머지는 유지
    expect(seen[0].opts?.delegate?.brains).not.toContain('claude-B');
  });

  it('기본 지휘자(채널 두뇌 이름 미지정)는 위임 목록에 자기 이름 관련 제외가 없다(회귀 0)', async () => {
    const seen: { opts?: CompleteOpts }[] = [];
    const defaultBrain: BrainProvider = {
      canDelegate: true,
      complete: async (_p, _c, opts) => { seen.push({ opts }); return { text: 'ok', costUsd: 0, isError: false }; },
    };
    const worker = { complete: async () => ({ text: 'w', costUsd: 0, isError: false }) } as BrainProvider;
    const delegator = new BrainDelegator(() => worker, () => ['claude', 'ollama']);
    const resolver = new ChannelBrainResolver(() => defaultBrain, defaultBrain, logger);
    const reader = new ReaderAgent(rag, defaultBrain, logger, undefined, undefined, delegator, resolver);
    await reader.handle({ text: 'q', userId: 'c1' }); // brain 미지정
    expect(seen[0].opts?.delegate?.brains).toEqual(['claude', 'ollama']);
  });

  // 동시성 격리(가벼운 버전, 최종 리뷰 제안): 서로 다른 채널 두뇌로 동시에 handle해도 각자 자기
  // 인스턴스로만 불리고 서로 뒤섞이지 않는다 — reader-agent.ts의 brain 지역 변수(this.brain에 대입하지
  // 않음) 계약이 실제 동시 실행 하에서도 지켜지는지 확인.
  it('동시 handle() — 서로 다른 채널 두뇌는 각자 자기 인스턴스로만 불린다(격리)', async () => {
    const cache = new Map<string, BrainProvider>();
    const callsByName: Record<string, number> = {};
    const resolveByName = (name: string): BrainProvider => {
      if (!cache.has(name)) {
        callsByName[name] = 0;
        cache.set(name, {
          complete: async () => {
            callsByName[name]++;
            await new Promise((r) => setTimeout(r, 5));
            return { text: `답-${name}`, costUsd: 0, isError: false };
          },
        });
      }
      return cache.get(name)!;
    };
    const defaultBrain: BrainProvider = { complete: async () => ({ text: '기본', costUsd: 0, isError: false }) };
    const resolver = new ChannelBrainResolver(resolveByName, defaultBrain, logger);
    const reader = new ReaderAgent(rag, defaultBrain, logger, undefined, undefined, undefined, resolver);
    const [outA, outB] = await Promise.all([
      reader.handle({ text: 'qA', userId: 'cA', brain: 'brain-A' }),
      reader.handle({ text: 'qB', userId: 'cB', brain: 'brain-B' }),
    ]);
    expect(outA).toContain('답-brain-A');
    expect(outB).toContain('답-brain-B');
    expect(callsByName['brain-A']).toBe(1);
    expect(callsByName['brain-B']).toBe(1);
    expect(cache.get('brain-A')).not.toBe(cache.get('brain-B')); // 서로 다른 인스턴스
  });
});
