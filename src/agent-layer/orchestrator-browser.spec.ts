import { Orchestrator } from './orchestrator';
import type { BrowserOp } from '../../shared/browser-ops';

const logger = { warn() {}, error() {}, log() {} } as any;

// AI 웹 조작(2단계) — 코드 채널 턴에 "채널이 묶인" 조작 경로가 실리는지. 이 배선이 곧
// 채널 정체성 바인딩이다(자체 하네스=클로저 / CLI 하네스=spawn env).
function makeOrch(bus?: { request(channelId: string, op: BrowserOp): Promise<{ ok: boolean; text: string }> }) {
  const calls: any[] = [];
  const brain = {
    complete: async (_p: string, _c: unknown, opts: any) => { calls.push(opts); return { text: '봤어요', costUsd: 0, isError: false }; },
  } as any;
  const conversations = { append: async () => {}, recent: async () => [] } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    {} as any, null as any, null as any, null as any, null as any,
    brain, { assertWritable() {} } as any, null as any, { all: () => [] } as any, null as any,
  );
  if (bus) o.setBrowserBus(bus);
  return { orch: o, calls };
}

async function ask(orch: Orchestrator, channelId: string) {
  await orch.handleMention(
    { text: '화면 확인해줘', userId: channelId, mode: 'code', repoPath: 'C:/repo/app' },
    async () => {},
    channelId,
  );
}

it('버스 미주입이면 env·browser·MCP 허용이 전혀 안 붙는다(회귀 0)', async () => {
  const { orch, calls } = makeOrch();
  await ask(orch, 'c1');
  expect(calls[0].env).toBeUndefined();
  expect(calls[0].browser).toBeUndefined();
  expect(calls[0].extraArgs).toEqual(['--allowedTools', 'Read,Glob,Grep,WebSearch,WebFetch', '--add-dir', 'C:/repo/app']);
});

it('버스가 있으면 ①CLI용 spawn env ②자체 하네스용 클로저 ③엔그램 MCP 허용이 함께 붙는다', async () => {
  const seen: Array<{ channelId: string; op: BrowserOp }> = [];
  const { orch, calls } = makeOrch({ request: async (channelId, op) => { seen.push({ channelId, op }); return { ok: true, text: 'done' }; } });
  await ask(orch, 'chan-A');
  expect(calls[0].env).toEqual({ ENGRAM_CHANNEL_ID: 'chan-A' });
  expect(calls[0].extraArgs[1]).toContain('mcp__engram');
  expect(calls[0].extraArgs[1]).toContain('mcp__plugin_engram_engram');
  // 클로저에 채널이 이미 묶여 있다 — 호출자는 채널을 지정하지 않는다(지정할 수도 없다).
  await calls[0].browser({ kind: 'read' });
  expect(seen).toEqual([{ channelId: 'chan-A', op: { kind: 'read' } }]);
});

it('★두 채널이 동시에 열려 있어도 각자 자기 칸만 조작한다', async () => {
  const seen: string[] = [];
  const { orch, calls } = makeOrch({ request: async (channelId) => { seen.push(channelId); return { ok: true, text: 'ok' }; } });
  await ask(orch, 'chan-A');
  await ask(orch, 'chan-B');
  expect(calls.map((c: any) => c.env.ENGRAM_CHANNEL_ID)).toEqual(['chan-A', 'chan-B']);
  await calls[0].browser({ kind: 'click', target: '#a' });
  await calls[1].browser({ kind: 'click', target: '#b' });
  expect(seen).toEqual(['chan-A', 'chan-B']); // 클로저가 섞이지 않는다
});
