import { Test } from '@nestjs/testing';
import { BrainModule } from './brain.module';
import { BRAIN, BrainProvider } from './brain.port';
import { FakeBrain } from './fake-brain';

describe('BrainModule', () => {
  it('BRAIN 토큰을 FakeBrain으로 override해 해소한다', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [BrainModule] })
      .overrideProvider(BRAIN).useValue(new FakeBrain({ text: 'ok', costUsd: 0, isError: false }))
      .compile();
    const brain = moduleRef.get<BrainProvider>(BRAIN);
    const r = await brain.complete('q');
    expect(r.text).toBe('ok');
    await moduleRef.close();
  });
});
