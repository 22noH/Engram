import { Orchestrator } from './orchestrator';
import { ChannelBrainResolver } from './channel-brain-resolver';
import type { ChatMessage } from '../edge/messenger/chat-store';

const logger = { warn() {}, error() {}, log() {} } as any;

// orchestrator-compact.spec.ts와 동일한 생성자 자리 채우기 관례(20인자 중 필요한 자리만).
// chatStoreForBrain은 setChannelBrainSource(setter)로 채널→브레인 조회를 주입한다(autoCompact가
// channelBrainOf로 그 채널의 "현재" 브레인 이름을 조회하는 경로 — Finding 1과 동일 결).
function orc(opts: { codeBrain?: any; channelBrain?: any } = {}) {
  const conversations = { append: async () => {} } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    opts.codeBrain ?? null, null as any, null as any, null as any, null as any,
    null as any, opts.channelBrain,
  ) as any as Orchestrator;
  return o;
}

function msg(id: string, text: string): ChatMessage {
  return { id, authorId: 'u1', text, ts: '2026-07-22T00:00:00.000Z' };
}

describe('Orchestrator.autoCompact (clear-compact Task 5)', () => {
  it('compactSvc + 브레인 해소 → summarizeToWiki(channelId, dropped, {brain, auto:true}) 호출 + {slug} 반환', async () => {
    const brain = { complete: async () => ({ text: '', costUsd: 0, isError: false }) };
    const resolver = new ChannelBrainResolver(() => brain as any, brain as any, logger);
    const o = orc({ channelBrain: resolver });
    const calls: any[] = [];
    const compactSvc = {
      compact: async () => null, // autoCompact가 이걸 부르면 안 됨(compact 아님)
      summarizeToWiki: async (channelId: string, msgs: ChatMessage[], opts: any) => {
        calls.push({ channelId, msgs, opts });
        return { slug: 'auto-compact-c1' };
      },
    };
    (o as any).setCompactService(compactSvc);
    const dropped = [msg('m1', 'old text')];

    const r = await o.autoCompact('c1', dropped);

    expect(r).toEqual({ slug: 'auto-compact-c1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].channelId).toBe('c1');
    expect(calls[0].msgs).toBe(dropped);
    expect(calls[0].opts.brain).toBe(brain);
    expect(calls[0].opts.auto).toBe(true); // 자동 compact는 항상 auto:true(카테고리 태그 구분용)
  });

  it('compactSvc 미주입 → null(호출 없음, throw 없음)', async () => {
    const o = orc();
    await expect(o.autoCompact('c1', [msg('m1', 'x')])).resolves.toBeNull();
  });

  it('summarizeToWiki가 throw해도 캐치돼 null(예외 전파 없음 — never-throw)', async () => {
    const brain = { complete: async () => ({ text: '', costUsd: 0, isError: false }) };
    const o = orc({ codeBrain: brain });
    const compactSvc = {
      compact: async () => null,
      summarizeToWiki: async () => { throw new Error('wiki save failed'); },
    };
    (o as any).setCompactService(compactSvc);
    await expect(o.autoCompact('c1', [msg('m1', 'x')])).resolves.toBeNull();
  });

  it('브레인 미해소(codeBrain·channelBrain 둘 다 없음) → null(summarizeToWiki는 안 불림)', async () => {
    const o = orc();
    const calls: any[] = [];
    const compactSvc = {
      compact: async () => null,
      summarizeToWiki: async (...args: any[]) => { calls.push(args); return { slug: 'x' }; },
    };
    (o as any).setCompactService(compactSvc);
    const r = await o.autoCompact('c1', [msg('m1', 'x')]);
    expect(r).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('채널의 "현재" 브레인(chatStoreForBrain)이 이름 지정 브레인으로 해소된다', async () => {
    const defaultBrain = { complete: async () => ({ text: '', costUsd: 0, isError: false }) };
    const namedBrain = { complete: async () => ({ text: '', costUsd: 0, isError: false }) };
    const resolver = new ChannelBrainResolver(
      (name) => (name === 'qwen' ? (namedBrain as any) : (defaultBrain as any)),
      defaultBrain as any,
      logger,
    );
    const o = orc({ channelBrain: resolver });
    (o as any).setChannelBrainSource({ listChannels: () => [{ id: 'c1', brain: 'qwen' }] });
    const calls: any[] = [];
    const compactSvc = {
      compact: async () => null,
      summarizeToWiki: async (_channelId: string, _msgs: ChatMessage[], opts: any) => { calls.push(opts.brain); return { slug: 'y' }; },
    };
    (o as any).setCompactService(compactSvc);

    await o.autoCompact('c1', [msg('m1', 'x')]);

    expect(calls[0]).toBe(namedBrain);
  });

  it('summarizeToWiki가 null을 반환하면(요약/위키 실패) autoCompact도 null(안전 우선)', async () => {
    const brain = { complete: async () => ({ text: '', costUsd: 0, isError: false }) };
    const o = orc({ codeBrain: brain });
    const compactSvc = {
      compact: async () => null,
      summarizeToWiki: async () => null,
    };
    (o as any).setCompactService(compactSvc);
    await expect(o.autoCompact('c1', [msg('m1', 'x')])).resolves.toBeNull();
  });
});
