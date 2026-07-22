import { Orchestrator } from './orchestrator';
import { ChannelBrainResolver } from './channel-brain-resolver';

const logger = { warn() {}, error() {}, log() {} } as any;

// 생성자 20인자(reader..channelBrain) 중 이 스펙에 필요한 자리만 채운다. compactSvc/브레인은
// setCompactService(setter)·codeBrain(14번째)·channelBrain(20번째)로 케이스별로 갈아 끼운다.
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

describe('Orchestrator.compactChannel', () => {
  it('compactSvc + channelBrain 해소 → compactSvc.compact(channelId, {brain}) 호출 + {slug} 반환', async () => {
    const brain = { complete: async () => ({ text: '', costUsd: 0, isError: false }) };
    const resolver = new ChannelBrainResolver(() => brain as any, brain as any, logger);
    const o = orc({ channelBrain: resolver });
    const calls: any[] = [];
    const compactSvc = {
      compact: async (channelId: string, opts: any) => { calls.push({ channelId, opts }); return { summary: 's', slug: 'chat-compact-c1' }; },
    };
    (o as any).setCompactService(compactSvc);
    const r = await o.compactChannel('c1');
    expect(r).toEqual({ slug: 'chat-compact-c1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].channelId).toBe('c1');
    expect(calls[0].opts.brain).toBe(brain);
  });

  it('compactSvc 미주입 → null(호출 없음, throw 없음)', async () => {
    const o = orc();
    await expect(o.compactChannel('c1')).resolves.toBeNull();
  });

  it('compactSvc.compact가 throw → 캐치돼 null(예외 전파 없음)', async () => {
    const brain = { complete: async () => ({ text: '', costUsd: 0, isError: false }) };
    const o = orc({ codeBrain: brain });
    const compactSvc = { compact: async () => { throw new Error('boom'); } };
    (o as any).setCompactService(compactSvc);
    await expect(o.compactChannel('c1')).resolves.toBeNull();
  });

  it('브레인 미해소(codeBrain·channelBrain 둘 다 없음) → null(compactSvc는 안 불림)', async () => {
    const o = orc();
    const calls: any[] = [];
    const compactSvc = { compact: async (...args: any[]) => { calls.push(args); return { summary: 's', slug: 'x' }; } };
    (o as any).setCompactService(compactSvc);
    const r = await o.compactChannel('c1');
    expect(r).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('brainName 지정 → resolveMsgBrain에 msg.brain으로 전달(채널 두뇌 해소 경유)', async () => {
    const defaultBrain = { complete: async () => ({ text: '', costUsd: 0, isError: false }) };
    const namedBrain = { complete: async () => ({ text: '', costUsd: 0, isError: false }) };
    const resolver = new ChannelBrainResolver((name) => (name === 'qwen' ? (namedBrain as any) : (defaultBrain as any)), defaultBrain as any, logger);
    const o = orc({ channelBrain: resolver });
    const calls: any[] = [];
    const compactSvc = { compact: async (_channelId: string, opts: any) => { calls.push(opts.brain); return { summary: 's', slug: 'y' }; } };
    (o as any).setCompactService(compactSvc);
    await o.compactChannel('c1', 'qwen');
    expect(calls[0]).toBe(namedBrain);
  });
});
