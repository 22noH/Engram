import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CliGateway } from './edge/cli.gateway';
import { PathResolver } from './pal/path-resolver';
import { runSettingsCommand } from './edge/settings-cli';

// CLI 진입점(설계 §9.1). main.ts(상주)와 분리 — 질문하고 종료.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // `engram config …`는 Nest를 부팅하지 않는다 — 설정 파일만 읽고 쓰는 일에 임베딩 모델 로드를
  // 기다릴 이유가 없다(engram-server CLI와 같은 결의 경량 경로). 판정·검증 로직은 앱·MCP와
  // 공유하는 edge/settings-registry.ts 한 곳에만 있다.
  if (argv[0] === 'config') {
    const paths = new PathResolver();
    const { output, exitCode } = runSettingsCommand(argv.slice(1), paths.getConfigDir());
    process.stdout.write(output);
    process.exit(exitCode);
  }

  // 부팅이 말없이 길어 보이지 않게 진행상황을 stderr로 알린다(최초 1회 임베딩 모델 로드로 느릴 수 있음).
  process.stderr.write('Engram 부팅 중… (최초 실행은 임베딩 모델 로드로 수십 초 걸릴 수 있음)\n');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  await app.init();
  process.stderr.write('준비됨.\n');
  const gateway = app.get(CliGateway);
  await gateway.run(argv);
  await app.close();
}

void main();
