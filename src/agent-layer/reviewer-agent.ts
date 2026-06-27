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
      '너는 코드 리뷰어다. 오직 아래 "완성조건"이 충족됐는지만 판단한다.',
      '하드 게이트(테스트·빌드·타입체크)는 이미 Engram이 통과시켰다 — 코드는 객관 검증을 통과한 상태다.',
      '완성조건이 모두 충족됐다고 보이면 approved=true, extraTickets=[]. (게이트가 초록이면 대개 충족이다.)',
      '충족 안 된 완성조건이 있을 때만, 그 조건 하나당 티켓 하나를 낸다.',
      '절대 금지: CI·워크플로·도구·테스트 추가·리팩터·프로세스·문서·"회귀 게이트" 같은 완성조건 *밖*의 제안은 extraTickets에 넣지 마라. 아래 완성조건 목록에 적힌 것만 본다.',
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
