// /compact 코어(설계 §compact): 채널 브레인이 대화를 요약 → 위키에 게시(dedup, MCP propose+approve와
// 동일 경로) → 대화 기록 정리 → 요약을 새 앵커 메시지로 append. 위키/RAG는 요약만 받는다(원문 유출 금지).
// 순서·안전선(요약 실패·위키 저장 실패는 절대 clear 안 함=지식 유실 방지)은 플랜 문서 참조.

import { BrainProvider, BrainResult } from '../brain/brain.port';
import { ChatStore } from '../edge/messenger/chat-store';
import { loadPrompt } from './prompt-store';
import { outputDirective } from './language';
import { slugifyMcpTitle } from '../edge/mcp/mcp-propose';
import { DEFAULT_USER } from '../pal/path-resolver';
import type { NewProposal, Proposal } from '../knowledge-core/proposal-store';

// prompts/compact-summary.md 없을 때의 내장 기본값(out-of-box 보장). 파일 내용과 동일하게 유지.
export const COMPACT_SUMMARY_DEFAULT = [
  'You are given a chat conversation transcript. Turn it into a concise wiki page that preserves the durable knowledge from the conversation — decisions made, facts learned, problems solved, open questions — and skips small talk and filler.',
  'Output format: the first line is a short, plain-text title (no markdown heading marks). Leave a blank line, then list the key points as bullets, one idea per bullet, terse and factual.',
  'Do not quote or restate the transcript verbatim — distill it into knowledge a future reader can use without having seen the conversation.',
  'If the conversation has no durable knowledge (pure chit-chat), still produce a short topic title and a single bullet noting nothing significant was decided.',
].join('\n');

// 프롬프트 조립. instruction은 loadPrompt('compact-summary', COMPACT_SUMMARY_DEFAULT) 결과.
export function buildCompactSummaryPrompt(instruction: string, ctx: { transcript: string }): string {
  return [
    instruction,
    outputDirective('source'), // 대화 언어 그대로 요약(다국어 채널 대응)
    '',
    '# Conversation transcript',
    ctx.transcript,
  ].join('\n');
}

// 요약 첫 줄에서 위키 제목을 뽑는다(마크다운 heading/bullet 표식은 제거). 빈 줄뿐이면 채널 기반 폴백.
function deriveTitle(summary: string, channelId: string): string {
  const firstLine = summary
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? '';
  const stripped = firstLine.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, '').trim();
  return stripped || `Chat compact — ${channelId}`;
}

// MCP wiki_propose(mcp-propose.ts)와 동일한 구조적 타입 — 실 WikiEngine/ProposalStore/ProposalApplier도
// 만족하고, 테스트는 jest.fn() 목으로도 만족시킬 수 있게 최소 인터페이스만 요구한다.
export interface CompactWiki {
  getPage(slug: string, userId?: string): Promise<unknown | null>;
}
export interface CompactProposals {
  enqueue(p: NewProposal): Promise<Proposal>;
}
export interface CompactApplier {
  apply(p: Proposal): Promise<void>;
}

export interface CompactResult {
  summary: string;
  slug: string;
}

export interface CompactOpts {
  brain: BrainProvider;
  auto?: boolean; // true=보존 프루닝 직전 자동 compact(카테고리 태그만 다름 — 사후 검토용)
}

export class CompactService {
  constructor(
    private readonly chat: ChatStore,
    private readonly wiki: CompactWiki,
    private readonly proposals: CompactProposals,
    private readonly applier: CompactApplier,
  ) {}

  // 채널 대화 → 요약 → 위키 게시 → 정리. 빈 채널/요약 실패/위키 저장 실패는 null(대화 그대로 보존).
  async compact(channelId: string, opts: CompactOpts): Promise<CompactResult | null> {
    // ★전체 대화를 읽는다(리뷰 지적): clearChannel은 채널 전체 jsonl을 지우므로, 요약도 반드시 전체를
    // 덮어야 한다. 상한(예: 500)을 두면 그걸 넘는 오래된 메시지가 위키에 안 담긴 채 삭제돼 지식이 유실됨.
    // 채널이 너무 커 브레인이 감당 못 하면 complete가 isError → null 반환 → clear 안 함(안전).
    const msgs = this.chat.history(channelId, { limit: Number.MAX_SAFE_INTEGER });
    if (msgs.length === 0) return null;

    const transcript = msgs.map((m) => `${m.authorName ?? m.authorId}: ${m.text}`).join('\n');
    const prompt = buildCompactSummaryPrompt(loadPrompt('compact-summary', COMPACT_SUMMARY_DEFAULT), { transcript });

    let r: BrainResult;
    try {
      r = await opts.brain.complete(prompt);
    } catch (e) {
      console.warn(`[compact] 채널 '${channelId}' 브레인 호출 실패(정리 안 함): ${String(e)}`);
      return null; // 요약 실패 — 절대 clear 안 함(지식 유실 방지)
    }
    if (r.isError || !r.text.trim()) return null; // 위와 동일 이유

    const summary = r.text.trim();
    const title = deriveTitle(summary, channelId);
    const targetSlug = slugifyMcpTitle(title);

    try {
      // dedup: 같은 주제 페이지가 있으면 append, 없으면 create(MCP wiki_propose와 동일 규칙).
      const existing = await this.wiki.getPage(targetSlug);
      const p = await this.proposals.enqueue({
        userId: DEFAULT_USER,
        op: existing ? 'append' : 'create',
        targetSlug,
        title,
        category: opts.auto ? 'auto-compact' : 'compact-summary',
        payload: summary, // 요약만 — 대화 원문은 절대 위키로 흘리지 않는다.
        sources: ['compact'],
        importance: 3,
        verdict: { confidence: 0.5, reason: 'channel compact summary' },
      });
      await this.applier.apply(p); // propose+approve를 한 번에(명령 자체가 사용자 동의)
    } catch (e) {
      // 위키 저장 실패 — 정리(clear)하면 지식이 통째로 사라지므로 여기서도 절대 clear 안 함.
      console.warn(`[compact] 채널 '${channelId}' 위키 저장 실패(정리 안 함): ${String(e)}`);
      return null;
    }

    this.chat.clearChannel(channelId);
    // 요약 메시지는 clear 이후 append하는 새 앵커 — 실행취소/백업 대상이 아니다.
    // never-throw(리뷰 지적): appendMessage는 try/catch가 없어 디스크풀/윈도우 잠금 시 던질 수 있다.
    // 여기서 던지면 compact가 CompactResult|null 계약을 깨고 caller로 튄다 — 감싸서 로그 후 계속.
    // (위키 저장은 이미 성공, 원본은 .cleared에 있으므로 앵커 실패해도 지식 손실은 없음.)
    try {
      this.chat.appendMessage(channelId, {
        authorId: 'engram',
        authorName: 'Engram',
        text: `${summary}\n\n📄 위키: ${targetSlug}`,
      });
    } catch (e) {
      console.warn(`[compact] 채널 '${channelId}' 앵커 메시지 기록 실패(무시): ${String(e)}`);
    }

    return { summary, slug: targetSlug };
  }
}
