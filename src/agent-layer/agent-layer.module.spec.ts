import { Test } from '@nestjs/testing';
import { AgentLayerModule } from './agent-layer.module';
import { Orchestrator } from './orchestrator';
import { BRAIN } from '../brain/brain.port';
import { FakeBrain } from '../brain/fake-brain';
import { EMBEDDER } from '../knowledge-core/rag/embedder.port';
import { FakeEmbedder } from '../knowledge-core/rag/fake-embedder';
import { PathResolver } from '../pal/path-resolver';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

describe('AgentLayerModule (integration)', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-al-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('Orchestrator를 해소하고 빈 위키에 질의하면 일반지식 머리말을 반환한다', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AgentLayerModule] })
      .overrideProvider(PathResolver).useValue(new PathResolver(dir))
      .overrideProvider(EMBEDDER).useClass(FakeEmbedder)
      .overrideProvider(BRAIN).useValue(new FakeBrain({ text: '일반답', costUsd: 0, isError: false }))
      .compile();
    await moduleRef.init();
    const orch = moduleRef.get(Orchestrator);
    const out = await orch.route({ text: '없는질문', userId: 'default' });
    expect(out).toContain('⚠ 위키에 관련 내용 없음');
    await moduleRef.close();
  });
});
