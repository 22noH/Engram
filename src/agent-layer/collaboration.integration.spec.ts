import * as os from 'os';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { BRAIN, JUDGE_BRAIN } from '../brain/brain.port';
import { FakeBrain } from '../brain/fake-brain';
import { EMBEDDER } from '../knowledge-core/rag/embedder.port';
import { FakeEmbedder } from '../knowledge-core/rag/fake-embedder';
import { Orchestrator } from './orchestrator';

// TaskStore 파일이 real runtime/ 폴더를 오염하지 않도록 임시 디렉토리 사용.
// PathResolver는 생성 시점에 ENGRAM_DATA_DIR를 읽으므로 AppModule 컴파일 전에 설정해야 함.
const tmpDir = path.join(os.tmpdir(), `engram-integration-${process.pid}`);
process.env.ENGRAM_DATA_DIR = tmpDir;

it('실 DI 그래프로 협업이 종합 답을 낸다(FakeBrain)', async () => {
  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(BRAIN).useValue(new FakeBrain({ text: '의견', costUsd: 0, isError: false }))
    .overrideProvider(JUDGE_BRAIN).useValue(new FakeBrain({ text: '종합', costUsd: 0, isError: false }))
    .overrideProvider(EMBEDDER).useValue(new FakeEmbedder())
    .compile();

  // init()으로 onModuleInit를 실행: PersonaRegistry.load()(8개 페르소나)와 RagStore.init() 수행.
  // FakeEmbedder 덕에 실 모델 다운로드 없이 LanceDB 초기화가 완료된다.
  await moduleRef.init();

  const orc = moduleRef.get(Orchestrator);
  const out = await orc.collaborate('전략?', ['Brand', 'Trend'], 'default');

  // FakeBrain(text:'종합')을 JUDGE_BRAIN으로 주입했으므로, 실 Synthesizer 경로에서 '종합'이 반환된다.
  expect(out).toContain('종합');

  await moduleRef.close();
}, 30000);
