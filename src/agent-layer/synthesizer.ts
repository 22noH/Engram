import { Injectable } from '@nestjs/common';
import { BrainProvider } from '../brain/brain.port';
import { outputDirective } from './language';

// 블랙보드 기여 종합(설계 §4 ④). 별도 두뇌 호출 — 작성자≠종합자(seam #5).
@Injectable()
export class Synthesizer {
  constructor(private readonly brain: BrainProvider) {}

  async synthesize(question: string, blackboard: Record<string, string>, onChunk?: (t: string) => void): Promise<string> {
    const entries = Object.entries(blackboard);
    if (entries.length === 0) return '전문가 기여가 없어 종합할 내용이 없습니다.';
    const body = entries.map(([who, txt]) => `## ${who}\n${txt}`).join('\n\n');
    const prompt = [
      'Below are opinions several experts each wrote on the same question. Synthesize them into one coherent answer.',
      'Where they conflict, surface the trade-offs; merge duplicates.',
      outputDirective('interactive'),
      `\n# Question\n${question}`,
      `\n# Expert opinions\n${body}`,
    ].join('\n');
    const r = await this.brain.complete(prompt, onChunk);
    return r.isError ? '종합 실패: 두뇌 호출 오류' : r.text;
  }
}
