import * as os from 'os';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { BRAIN, JUDGE_BRAIN } from '../brain/brain.port';
import { FakeBrain } from '../brain/fake-brain';
import { Orchestrator } from './orchestrator';

// TaskStore 파일이 real runtime/ 폴더를 오염하지 않도록 임시 디렉토리 사용.
// PathResolver는 생성 시점에 ENGRAM_DATA_DIR를 읽으므로 AppModule 컴파일 전에 설정해야 함.
const tmpDir = path.join(os.tmpdir(), `engram-integration-${process.pid}`);
process.env.ENGRAM_DATA_DIR = tmpDir;

it('실 DI 그래프로 협업이 종합 답을 낸다(FakeBrain)', async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(BRAIN).useValue(new FakeBrain({ text: '의견', costUsd: 0, isError: false }))
    .overrideProvider(JUDGE_BRAIN).useValue(new FakeBrain({ text: '종합', costUsd: 0, isError: false }))
    .compile();
  const orc = mod.get(Orchestrator);
  const out = await orc.collaborate('전략?', ['Brand', 'Trend'], 'default');
  expect(typeof out).toBe('string');
  await mod.close();
}, 30000);
