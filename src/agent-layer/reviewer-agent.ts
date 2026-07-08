import { Injectable, Inject } from '@nestjs/common';
import { BrainProvider, JUDGE_BRAIN } from '../brain/brain.port';
import { parseJsonBlock } from './parse-json-block';
import { loadPrompt } from './prompt-store';

export interface ReviewResult {
  approved: boolean;
  extraTickets: Array<{ area: string; instruction: string }>;
}

// prompts/review.md 없을 때의 내장 기본값. JSON 출력 계약은 review()가 코드에서 덧붙인다.
export const REVIEW_DEFAULT = [
  'You are a code reviewer. Judge only whether the "acceptance criteria" below are met.',
  'The hard gate (tests, build, typecheck) has already passed under Engram — the code is objectively verified.',
  'If all acceptance criteria appear met, approved=true, extraTickets=[]. (A green gate usually means they are met.)',
  'Only when an acceptance criterion is not met, emit one ticket per unmet criterion.',
  'Never put suggestions outside the acceptance criteria — CI, workflows, tooling, adding tests, refactors, process, docs, "regression gates" — into extraTickets. Look only at the acceptance-criteria list below.',
].join('\n');

// 소프트 위층(설계 §8.2, seam #5). 작성자≠검증자 → JUDGE_BRAIN.
// 추가 거부만 가능: 빨간 게이트를 못 덮고, 모호하면 보류(approved=false).
@Injectable()
export class ReviewerAgent {
  constructor(@Inject(JUDGE_BRAIN) private readonly brain: BrainProvider) {}

  async review(criteria: string[], landedSummary: string): Promise<ReviewResult> {
    const prompt = [
      loadPrompt('review', REVIEW_DEFAULT),
      `\n# Acceptance criteria\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
      `\n# Summary of landed changes\n${landedSummary}`,
      '\nOutput only this JSON: {"approved": boolean, "extraTickets": [{"area": "...", "instruction": "..."}]}',
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
