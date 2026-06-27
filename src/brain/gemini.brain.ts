import { Injectable } from '@nestjs/common';
import { BrainProvider, BrainResult } from './brain.port';
import { BrainProfile } from './brain.config';
import { Semaphore } from './semaphore';
import { spawnTextBrain } from './text-brain';

// Gemini CLI 어댑터(설계 §6.2). Phase 3=텍스트 생성. 도구 위임은 Phase 4.
@Injectable()
export class GeminiBrain implements BrainProvider {
  private readonly sem: Semaphore;

  constructor(private readonly profile: BrainProfile) {
    this.sem = new Semaphore(profile.concurrency);
  }

  complete(prompt: string, onChunk?: (text: string) => void): Promise<BrainResult> {
    // ponytail: gemini 출력형식은 설치본 따라 보정 — args가 노브
    const args = [
      '-p',
      prompt,
      ...(this.profile.model ? ['-m', this.profile.model] : []),
      ...this.profile.extraArgs,
    ];
    return this.sem.run(() => spawnTextBrain(this.profile, args, onChunk));
  }
}
