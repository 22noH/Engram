import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { InsightReporter } from './insight-reporter';
import { ConversationStore } from '../knowledge-core/conversation-store';
import { InsightStore } from '../knowledge-core/insight/insight-store';
import { PathResolver } from '../pal/path-resolver';
import { PinoLogger } from '../pal/logger';
import { BrainProvider } from '../brain/brain.port';

const okBrain = (text: string): BrainProvider => ({ complete: async () => ({ text, costUsd: 0, isError: false }) });
const errBrain = (): BrainProvider => ({ complete: async () => ({ text: '', costUsd: 0, isError: true }) });
const throwBrain = (): BrainProvider => ({ complete: async () => { throw new Error('network down'); } });

describe('InsightReporter', () => {
  let dir: string; let conv: ConversationStore; let store: InsightStore; let logger: PinoLogger;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reporter-'));
    const paths = new PathResolver(dir);
    conv = new ConversationStore(paths);
    store = new InsightStore(paths);
    logger = new PinoLogger(paths);
  });

  afterEach(() => {
    delete process.env.ENGRAM_INSIGHT_KEEP_DAYS;
  });

  it('그날 대화가 없으면 null, 저장도 안 함', async () => {
    const r = new InsightReporter(conv, store, okBrain('x'), logger);
    expect(await r.run('default', '2026-06-28')).toBeNull();
    expect(await store.latest('default')).toBeNull();
  });

  it('대화가 있으면 메트릭+리포트를 만들어 저장', async () => {
    await conv.append('default', { ts: '2026-06-28T01:00:00.000Z', question: 'docker 배포', answer: 'a', sources: ['guide'] });
    const r = new InsightReporter(conv, store, okBrain('오늘은 도커에 집중'), logger);
    const ins = await r.run('default', '2026-06-28');
    expect(ins?.report).toBe('오늘은 도커에 집중');
    expect(ins?.metrics.queryCount).toBe(1);
    expect(ins?.metrics.topPages[0].slug).toBe('guide');
    expect((await store.latest('default'))?.date).toBe('2026-06-28');
  });

  it('두뇌 오류면 리포트는 실패 표식이되 메트릭은 저장', async () => {
    await conv.append('default', { ts: '2026-06-28T01:00:00.000Z', question: 'q', answer: 'a' });
    const r = new InsightReporter(conv, store, errBrain(), logger);
    const ins = await r.run('default', '2026-06-28');
    expect(ins?.report).toContain('실패');
    expect(ins?.metrics.queryCount).toBe(1);
  });

  it('두뇌가 throw해도 메트릭은 저장된다', async () => {
    await conv.append('default', { ts: '2026-06-28T01:00:00.000Z', question: 'q', answer: 'a' });
    const r = new InsightReporter(conv, store, throwBrain(), logger);
    const ins = await r.run('default', '2026-06-28');
    expect(ins?.report).toContain('실패');
    expect(ins?.metrics.queryCount).toBe(1);
    expect((await store.latest('default'))?.metrics.queryCount).toBe(1);
  });

  it('run은 보존정책으로 오래된 인사이트를 정리한다', async () => {
    process.env.ENGRAM_INSIGHT_KEEP_DAYS = '1';
    await conv.append('default', { ts: '2026-06-27T01:00:00.000Z', question: 'q', answer: 'a' });
    await conv.append('default', { ts: '2026-06-28T01:00:00.000Z', question: 'q', answer: 'a' });
    const r = new InsightReporter(conv, store, okBrain('보고서'), logger);
    await r.run('default', '2026-06-27');
    await r.run('default', '2026-06-28');
    expect((await store.latest('default'))?.date).toBe('2026-06-28');
    expect(await store.get('default', '2026-06-27')).toBeNull(); // 오래된 건 삭제됨
    delete process.env.ENGRAM_INSIGHT_KEEP_DAYS;
  });

  it('ENGRAM_INSIGHT_KEEP_DAYS=0은 무제한(정리 안 함)', async () => {
    process.env.ENGRAM_INSIGHT_KEEP_DAYS = '0';
    await conv.append('default', { ts: '2026-06-27T01:00:00.000Z', question: 'q', answer: 'a' });
    await conv.append('default', { ts: '2026-06-28T01:00:00.000Z', question: 'q', answer: 'a' });
    const r = new InsightReporter(conv, store, okBrain('보고서'), logger);
    await r.run('default', '2026-06-27');
    await r.run('default', '2026-06-28');
    expect(await store.get('default', '2026-06-27')).not.toBeNull(); // 오래된 것도 보존
    expect(await store.get('default', '2026-06-28')).not.toBeNull();
  });

  it('ENGRAM_INSIGHT_KEEP_DAYS 미설정이면 무제한(정리 안 함)', async () => {
    delete process.env.ENGRAM_INSIGHT_KEEP_DAYS;
    await conv.append('default', { ts: '2026-06-27T01:00:00.000Z', question: 'q', answer: 'a' });
    await conv.append('default', { ts: '2026-06-28T01:00:00.000Z', question: 'q', answer: 'a' });
    const r = new InsightReporter(conv, store, okBrain('보고서'), logger);
    await r.run('default', '2026-06-27');
    await r.run('default', '2026-06-28');
    expect(await store.get('default', '2026-06-27')).not.toBeNull(); // 미설정=보존
    expect(await store.get('default', '2026-06-28')).not.toBeNull();
  });
});
