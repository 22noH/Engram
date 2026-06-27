import { Injectable } from '@nestjs/common';
import { BrainProvider, BrainResult } from './brain.port';
import { BrainProfile } from './brain.config';
import { Semaphore } from './semaphore';
import { spawnTextBrain } from './text-brain';

// Codex CLI 어댑터(설계 §6.2). Phase 3=텍스트 생성. 고유 코딩 하네스는 Phase 4.
@Injectable()
export class CodexBrain implements BrainProvider {
  private readonly sem: Semaphore;

  constructor(private readonly profile: BrainProfile) {
    this.sem = new Semaphore(profile.concurrency);
  }

  complete(prompt: string, onChunk?: (text: string) => void): Promise<BrainResult> {
    // ponytail: codex 실행 플래그·출력은 설치본 따라 보정
    const args = ['exec', prompt, ...this.profile.extraArgs];
    return this.sem.run(() => spawnTextBrain(this.profile, args, onChunk));
  }
}
