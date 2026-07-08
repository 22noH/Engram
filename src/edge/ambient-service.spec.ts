import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { AmbientService } from './ambient-service';
import { FakeMessenger } from './messenger/fake-messenger';
import { DEFAULT_USER } from '../pal/path-resolver';

const logger = { warn() {}, log() {} } as any;
const OPEN = { channels: {} } as any; // 기본값 = ambient 허용

// 채널 디렉토리 셋업: state/conversations/{channelId}/
function tmpRoot(...channels: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-amb-'));
  for (const c of channels) fs.mkdirSync(path.join(root, c), { recursive: true });
  return root;
}

function svc(opts: {
  root: string;
  insight?: (u: string, d?: string) => Promise<any>;
  pending?: (u?: string) => Promise<any[]>;
  policy?: any;
}) {
  const port = new FakeMessenger();
  const calls: Array<[string, string?]> = [];
  const orchestrator = { insight: async (u: string, d?: string) => { calls.push([u, d]); return opts.insight ? opts.insight(u, d) : null; } };
  const proposals = { listPending: opts.pending ?? (async () => []) } as any;
  const registry = { addCronJob() {}, deleteCronJob() {} } as any;
  const s = new AmbientService(orchestrator as any, port, registry, proposals, opts.policy ?? OPEN, opts.root, logger) as any;
  s.yesterday = () => '2026-07-01';
  s.makeJob = () => ({ start() {}, stop() {} });
  return { s, port, calls };
}

it('인사이트 있는 채널만 ☀️ 게시(어제 날짜로 호출, 기본 en)', async () => {
  const root = tmpRoot('c1', 'c2');
  const { s, port, calls } = svc({
    root,
    insight: async (u) => (u === 'c1' ? { date: '2026-07-01', report: '어제는 RAG 얘기가 많았어요' } : null),
  });
  await s.tick();
  expect(calls).toEqual(expect.arrayContaining([['c1', '2026-07-01'], ['c2', '2026-07-01']]));
  const suns = port.channelPosts.filter((p) => p.text.startsWith('☀️'));
  expect(suns).toEqual([{ channelId: 'c1', threadId: undefined, text: '☀️ Yesterday in this channel: 어제는 RAG 얘기가 많았어요' }]);
});

it('결재 대기>0 채널만 📋 게시(기본 en)', async () => {
  const root = tmpRoot('c1', 'c2');
  const { s, port } = svc({ root, pending: async (u) => (u === 'c2' ? [{}, {}, {}] : []) });
  await s.tick();
  const notes = port.channelPosts.filter((p) => p.text.startsWith('📋'));
  expect(notes).toEqual([{ channelId: 'c2', threadId: undefined, text: '📋 3 wiki item(s) awaiting approval — approve them with `engram review` in the terminal' }]);
});

it('결재 대기>0 채널만 📋 게시(ENGRAM_LANG=ko)', async () => {
  process.env.ENGRAM_LANG = 'ko';
  try {
    const root = tmpRoot('c1', 'c2');
    const { s, port } = svc({ root, pending: async (u) => (u === 'c2' ? [{}, {}, {}] : []) });
    await s.tick();
    const notes = port.channelPosts.filter((p) => p.text.startsWith('📋'));
    expect(notes).toEqual([{ channelId: 'c2', threadId: undefined, text: '📋 위키 결재 대기 3건 — 터미널에서 engram review로 승인해줘' }]);
  } finally {
    delete process.env.ENGRAM_LANG;
  }
});

it('ambient=false 채널은 스킵(insight 미호출)', async () => {
  const root = tmpRoot('c1');
  const { s, port, calls } = svc({ root, policy: { channels: { c1: { ambient: false } } } });
  await s.tick();
  expect(calls).toHaveLength(0);
  expect(port.channelPosts).toHaveLength(0);
});

it('DEFAULT_USER 디렉토리는 채널이 아님(제외)', async () => {
  const root = tmpRoot(DEFAULT_USER, 'c1');
  const { s, calls } = svc({ root });
  await s.tick();
  expect(calls.map(([u]) => u)).toEqual(['c1']);
});

it('한 채널이 throw해도 나머지 진행(상주 불사)', async () => {
  const root = tmpRoot('bad', 'good');
  const { s, calls } = svc({
    root,
    insight: async (u) => { if (u === 'bad') throw new Error('boom'); return null; },
  });
  await expect(s.tick()).resolves.toBeUndefined();
  expect(calls.map(([u]) => u).sort()).toEqual(['bad', 'good']);
});

it('conversations 루트 없음 → 무동작 no-throw', async () => {
  const { s, port } = svc({ root: path.join(os.tmpdir(), 'engram-amb-none-여기없음') });
  await expect(s.tick()).resolves.toBeUndefined();
  expect(port.channelPosts).toHaveLength(0);
});
