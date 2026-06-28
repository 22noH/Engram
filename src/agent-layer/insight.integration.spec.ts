import * as os from 'os';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { BRAIN, JUDGE_BRAIN } from '../brain/brain.port';
import { FakeBrain } from '../brain/fake-brain';
import { EMBEDDER } from '../knowledge-core/rag/embedder.port';
import { FakeEmbedder } from '../knowledge-core/rag/fake-embedder';
import { Orchestrator } from './orchestrator';
import { InsightStore } from '../knowledge-core/insight/insight-store';
import { InsightContext } from '../knowledge-core/insight/insight-context';

// collaboration.integration.spec.ts와 동일 부트스트랩 패턴.
// PathResolver는 생성 시점에 ENGRAM_DATA_DIR를 읽으므로 AppModule 컴파일 전에 설정해야 함.
const tmpDir = path.join(os.tmpdir(), `engram-insight-integration-${process.pid}`);
process.env.ENGRAM_DATA_DIR = tmpDir;

// FakeBrain 고정 응답. InsightReporter가 이 값을 report로 저장한다.
const FAKE_REPORT = '오늘은 도커 배포 관련 질의가 있었고, 인프라 설정에 집중한 하루였다.';

it('ask → insight 생성 → InsightStore.latest → InsightContext.latest 동작(실 DI 그래프)', async () => {
  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(BRAIN).useValue(new FakeBrain({ text: FAKE_REPORT, costUsd: 0, isError: false }))
    .overrideProvider(JUDGE_BRAIN).useValue(new FakeBrain({ text: FAKE_REPORT, costUsd: 0, isError: false }))
    .overrideProvider(EMBEDDER).useValue(new FakeEmbedder())
    .compile();

  // init()으로 onModuleInit 실행: PersonaRegistry.load() + RagStore.init().
  // FakeEmbedder 덕에 실 모델 다운로드 없이 LanceDB 초기화 완료.
  await moduleRef.init();

  const orch = moduleRef.get(Orchestrator);

  // 1) 질문 1건 route → ConversationStore에 sources 포함 적재.
  await orch.route({ text: '도커 배포 어떻게', userId: 'default' });

  // 2) insight('default') → DayInsight 생성.
  const ins = await orch.insight('default');
  expect(ins).not.toBeNull();
  expect(ins!.metrics.queryCount).toBeGreaterThanOrEqual(1);
  expect(ins!.report).toBe(FAKE_REPORT);

  // 3) InsightStore.latest('default') 비어있지 않음.
  const store = moduleRef.get(InsightStore);
  const storedInsight = await store.latest('default');
  expect(storedInsight).not.toBeNull();
  expect(storedInsight!.report).toBe(FAKE_REPORT);

  // 4) InsightContext.latest('default') — 리포트 문자열이 컨텍스트에 포함됨.
  const ctx = moduleRef.get(InsightContext);
  const contextStr = await ctx.latest('default');
  expect(contextStr).not.toBe('');
  expect(contextStr).toContain(ins!.report);

  await moduleRef.close();
}, 30000);
