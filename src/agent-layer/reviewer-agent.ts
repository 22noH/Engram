import { Injectable, Inject } from '@nestjs/common';
import { BrainProvider, JUDGE_BRAIN } from '../brain/brain.port';
import { parseJsonBlock } from './parse-json-block';

export interface ReviewResult {
  approved: boolean;
  extraTickets: Array<{ area: string; instruction: string }>;
}

// 소프트 위층(설계 §8.2, seam #5). 작성자≠검증자 → JUDGE_BRAIN.
// 추가 거부만 가능: 빨간 게이트를 못 덮고, 모호하면 보류(approved=false).
@Injectable()
export class ReviewerAgent {
  constructor(@Inject(JUDGE_BRAIN) private readonly brain: BrainProvider) {}

  async review(criteria: string[], landedSummary: string): Promise<ReviewResult> {
    const prompt = [
      '너는 코드 리뷰어다. 아래 완성조건 대비 착지된 변경을 설계·의도 관점에서 본다.',
      '테스트가 못 잡는 누락·위험만 지적하라. 추가 작업이 필요하면 티켓으로 제안하라.',
      `\n# 완성조건\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
      `\n# 착지된 변경 요약\n${landedSummary}`,
      '\n반드시 이 JSON만 출력: {"approved": boolean, "extraTickets": [{"area": "...", "instruction": "..."}]}',
    ].join('\n');
    const r = await this.brain.complete(prompt);
    if (r.isError) return { approved: false, extraTickets: [] };
    const o = parseJsonBlock<{ approved?: unknown; extraTickets?: unknown }>(r.text);
    if (!o) return { approved: false, extraTickets: [] }; // 파싱 실패 → 보수적 보류
    return {
      approved: o.approved === true,
      extraTickets: Array.isArray(o.extraTickets)
        ? o.extraTickets.filter((t: any) => t && typeof t.area === 'string' && typeof t.instruction === 'string')
            .map((t: any) => ({ area: t.area, instruction: t.instruction }))
        : [],
    };
  }
}
