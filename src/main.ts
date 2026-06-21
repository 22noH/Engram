import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// Phase 0 부트스트랩. Gateway(Phase 1)가 붙기 전까지는 HTTP 리스닝 없이
// 모듈 그래프만 구성하는 standalone 컨텍스트로 띄운다.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.init();
}

void bootstrap();
