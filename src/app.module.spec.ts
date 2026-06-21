import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

describe('AppModule', () => {
  it('모듈이 컴파일된다', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    expect(moduleRef).toBeDefined();
  });
});
