import { Injectable } from '@nestjs/common';
import { BrainProvider, BrainResult, CompleteOpts } from './brain.port';

// 결정론적 가짜 두뇌. 실 claude 호출 없이 단위테스트에 쓴다(FakeEmbedder와 같은 역할).
@Injectable()
export class FakeBrain implements BrainProvider {
  constructor(
    private readonly result: BrainResult = { text: 'fake answer', costUsd: 0, isError: false },
  ) {}

  async complete(_prompt: string, onChunk?: (text: string) => void, _opts?: CompleteOpts): Promise<BrainResult> {
    if (onChunk) onChunk(this.result.text);
    return this.result;
  }
}
