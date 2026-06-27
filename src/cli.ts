import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CliGateway } from './edge/cli.gateway';

// CLI 진입점(설계 §9.1). main.ts(상주)와 분리 — 질문하고 종료.
async function main(): Promise<void> {
  // 부팅이 말없이 길어 보이지 않게 진행상황을 stderr로 알린다(최초 1회 임베딩 모델 로드로 느릴 수 있음).
  process.stderr.write('Engram 부팅 중… (최초 실행은 임베딩 모델 로드로 수십 초 걸릴 수 있음)\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  await app.init();
  process.stderr.write('준비됨.\n');
  const gateway = app.get(CliGateway);
  await gateway.run(process.argv.slice(2));
  await app.close();
}

void main();
