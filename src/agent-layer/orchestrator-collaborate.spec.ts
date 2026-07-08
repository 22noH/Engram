import { Orchestrator } from './orchestrator';
import { TaskStore } from '../knowledge-core/task-store';
import { KeyedLock } from '../knowledge-core/keyed-lock';
import { Semaphore } from '../brain/semaphore';
import { TurnBudget } from './turn-budget';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';

function store(): TaskStore {
  return new TaskStore(fs.mkdtempSync(path.join(os.tmpdir(), 'engram-orc-')), new KeyedLock());
}
const logger = { warn() {}, error() {}, info() {} } as any;

it('두 페르소나 기여를 블랙보드에 모아 종합하고 세션 SUCCESS', async () => {
  const ts = store();
  const specialist = { contribute: async (p: string) => `${p} 기여` } as any;
  const synth = { synthesize: async (_q: string, bb: Record<string, string>) => `종합(${Object.keys(bb).sort().join(',')})` } as any;
  // 협업에 필요한 협력자만 주입하는 생성자(아래 구현에서 reader 등 기존 의존은 옵셔널/유지)
  const orc = new Orchestrator(
    null as any, null as any, logger, null as any,
    ts, specialist, synth, new Semaphore(2),
  );
  const out = await orc.collaborate('런칭 전략?', ['Brand', 'Trend'], 'default');
  expect(out).toBe('종합(Brand,Trend)');
});

it('TurnBudget 소진 시 남은 페르소나는 스킵', async () => {
  const ts = store();
  const seen: string[] = [];
  const specialist = { contribute: async (p: string) => { seen.push(p); return `${p}`; } } as any;
  const synth = { synthesize: async (_q: string, bb: Record<string, string>) => Object.keys(bb).join(',') } as any;
  const orc = new Orchestrator(null as any, null as any, logger, null as any, ts, specialist, synth, new Semaphore(2));
  const out = await orc.collaborate('q', ['A', 'B', 'C'], 'default', { turnBudget: 1 });
  expect(seen.length).toBe(1); // 1턴만
  expect(out).toBe(seen[0]);
});

it('onProgress로 팀구성·각 기여·종합 진행을 게시한다(실패는 무시)', async () => {
  const ts = store();
  const specialist = { contribute: async (p: string) => `${p} 기여` } as any;
  const synth = { synthesize: async () => '종합' } as any;
  const orc = new Orchestrator(null as any, null as any, logger, null as any, ts, specialist, synth, new Semaphore(2));
  const posts: string[] = [];
  await orc.collaborate('전략?', ['Brand', 'Trend'], 'default', { onProgress: async (t) => { posts.push(t); } });
  expect(posts.some((p) => p.includes('Team') && p.includes('Brand') && p.includes('Trend'))).toBe(true);
  expect(posts.filter((p) => p.includes("input is in")).length).toBe(2);
  expect(posts.some((p) => p.includes('Synthesizing'))).toBe(true);
});

it('onProgress가 던져도 협업은 정상 완료된다', async () => {
  const ts = store();
  const specialist = { contribute: async (p: string) => `${p}` } as any;
  const synth = { synthesize: async () => 'OK' } as any;
  const orc = new Orchestrator(null as any, null as any, logger, null as any, ts, specialist, synth, new Semaphore(2));
  const out = await orc.collaborate('q', ['A'], 'default', { onProgress: async () => { throw new Error('post 실패'); } });
  expect(out).toBe('OK');
});
