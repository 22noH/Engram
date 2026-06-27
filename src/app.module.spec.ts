import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { Orchestrator } from './agent-layer/orchestrator';
import { EMBEDDER } from './knowledge-core/rag/embedder.port';
import { BRAIN, JUDGE_BRAIN } from './brain/brain.port';
import { FakeEmbedder } from './knowledge-core/rag/fake-embedder';
import { FakeBrain } from './brain/fake-brain';

describe('AppModule', () => {
  it('모듈이 컴파일된다', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMBEDDER).useValue(new FakeEmbedder())
      .overrideProvider(BRAIN).useValue(new FakeBrain())
      .overrideProvider(JUDGE_BRAIN).useValue(new FakeBrain())
      .compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it('Orchestrator가 코딩 협력자와 함께 해소된다', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMBEDDER).useValue(new FakeEmbedder())
      .overrideProvider(BRAIN).useValue(new FakeBrain())
      .overrideProvider(JUDGE_BRAIN).useValue(new FakeBrain())
      .compile();
    expect(moduleRef.get(Orchestrator)).toBeDefined();
    await moduleRef.close();
  });
});
