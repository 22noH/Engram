import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CliGateway } from './edge/cli.gateway';

// CLI 진입점(설계 §9.1). main.ts(상주)와 분리 — 질문하고 종료.
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  await app.init();
  const gateway = app.get(CliGateway);
  await gateway.run(process.argv.slice(2));
  await app.close();
}

void main();
