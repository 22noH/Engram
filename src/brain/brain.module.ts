import { Module } from '@nestjs/common';
import { PathResolver } from '../pal/path-resolver';
import { BRAIN } from './brain.port';
import { ClaudeCliBrain } from './claude-cli.brain';
import { loadActiveBrain } from './brain.config';

// 두뇌 포트 와이어링(설계 §7.5). brains.json의 활성 프로필로 ClaudeCliBrain을 만든다.
// 테스트는 BRAIN을 FakeBrain으로 override(팩토리·실 claude 우회).
@Module({
  providers: [
    {
      provide: BRAIN,
      useFactory: () => new ClaudeCliBrain(loadActiveBrain(new PathResolver().getConfigDir())),
    },
  ],
  exports: [BRAIN],
})
export class BrainModule {}
