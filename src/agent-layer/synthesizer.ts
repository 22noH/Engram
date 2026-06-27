import { Injectable } from '@nestjs/common';
import { BrainProvider } from '../brain/brain.port';

// 블랙보드 기여 종합(설계 §4 ④). 별도 두뇌 호출 — 작성자≠종합자(seam #5).
@Injectable()
export class Synthesizer {
  constructor(private readonly brain: BrainProvider) {}

  async synthesize(question: string, blackboard: Record<string, string>, onChunk?: (t: string) => void): Promise<string> {
    const entries = Object.entries(blackboard);
    if (entries.length === 0) return '전문가 기여가 없어 종합할 내용이 없습니다.';
    const body = entries.map(([who, txt]) => `## ${who}\n${txt}`).join('\n\n');
    const prompt = [
      '아래는 여러 전문가가 같은 질문에 대해 각자 적은 의견이다. 이를 하나의 일관된 답으로 종합하라.',
      '상충하면 트레이드오프를 밝히고, 중복은 합쳐라.',
      `\n# 질문\n${question}`,
      `\n# 전문가 의견\n${body}`,
    ].join('\n');
    const r = await this.brain.complete(prompt, onChunk);
    return r.isError ? '종합 실패: 두뇌 호출 오류' : r.text;
  }
}
