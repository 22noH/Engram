import { Module } from '@nestjs/common';
import { PathResolver } from '../pal/path-resolver';
import { BRAIN, JUDGE_BRAIN } from './brain.port';
import { ClaudeCliBrain } from './claude-cli.brain';
import { loadActiveBrain, loadBrainProfile } from './brain.config';

// 두뇌 포트 와이어링(설계 §7.5). brains.json의 활성 프로필로 ClaudeCliBrain을 만든다.
// JUDGE_BRAIN은 'judge' 프로필 해소(없으면 default 폴백 — 작성자≠검증자, opt-in 분리).
// 테스트는 BRAIN / JUDGE_BRAIN을 FakeBrain으로 override(팩토리·실 claude 우회).
@Module({
  providers: [
    {
      provide: BRAIN,
      useFactory: () => new ClaudeCliBrain(loadActiveBrain(new PathResolver().getConfigDir())),
    },
    {
      provide: JUDGE_BRAIN,
      useFactory: () => new ClaudeCliBrain(loadBrainProfile(new PathResolver().getConfigDir(), 'judge')),
    },
  ],
  exports: [BRAIN, JUDGE_BRAIN],
})
export class BrainModule {}
