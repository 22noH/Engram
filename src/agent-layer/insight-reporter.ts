import { Inject, Injectable } from '@nestjs/common';
import { BRAIN, BrainProvider, BrainResult } from '../brain/brain.port';
import { ConversationStore, ConversationRecord } from '../knowledge-core/conversation-store';
import { InsightStore, DayInsight } from '../knowledge-core/insight/insight-store';
import { computeDayMetrics, DayMetrics } from '../knowledge-core/insight/metrics';
import { loadPrompt } from './prompt-store';
import { PinoLogger } from '../pal/logger';
import { DEFAULT_USER } from '../pal/path-resolver';
import { outputDirective, configuredLang } from './language';

// prompts/insight.md 없을 때의 내장 기본값(out-of-box 보장).
const INSIGHT_DEFAULT =
  "You analyze the user's daily usage. Based on the metrics and conversations, " +
  'summarize in 3-5 sentences what they focused on today, how their attention shifted, ' +
  'and any unresolved questions. Write only what the records show, as prose paragraphs rather than a list.';

// 일일 인사이트 생성(설계 §5.4). 메트릭(결정적) + 두뇌 1콜 서술. agent-layer 위치 — BRAIN 소비(IngesterAgent와 동렬).
@Injectable()
export class InsightReporter {
  constructor(
    private readonly conversations: ConversationStore,
    private readonly store: InsightStore,
    @Inject(BRAIN) private readonly brain: BrainProvider,
    private readonly logger: PinoLogger,
  ) {}

  async run(userId: string = DEFAULT_USER, date?: string): Promise<DayInsight | null> {
    const day = date ?? new Date().toISOString().slice(0, 10);
    const records = await this.conversations.readDay(userId, day);
    if (records.length === 0) {
      this.logger.log(`인사이트 생략(${day} 대화 없음)`, 'InsightReporter');
      return null;
    }
    const metrics = computeDayMetrics(day, records);
    let result: BrainResult;
    try {
      result = await this.brain.complete(this.buildPrompt(metrics, records));
    } catch {
      result = { text: '', costUsd: 0, isError: true };
    }
    const report = result.isError ? '(리포트 생성 실패: 두뇌 오류 — 메트릭만 보존)' : result.text.trim();
    const insight: DayInsight = { date: day, metrics, report };
    await this.store.save(userId, insight);
    // 미설정/빈값/0/음수 = 무제한(prune이 no-op), 양수 = 그만큼 일수 유지. 데이터 삭제는 명시 opt-in.
    await this.store.prune(userId, Number(process.env.ENGRAM_INSIGHT_KEEP_DAYS));
    this.logger.log(`인사이트 생성: ${day} (질의 ${metrics.queryCount}건)`, 'InsightReporter');
    return insight;
  }

  private buildPrompt(metrics: DayMetrics, records: ConversationRecord[]): string {
    const qa = records
      .map((r, i) => `${i + 1}. Q: ${r.question}\n   A: ${r.answer.slice(0, 200)}`)
      .join('\n');
    return [
      loadPrompt('insight', INSIGHT_DEFAULT),
      outputDirective('autonomous', configuredLang()),
      '',
      `# Metrics`,
      `Queries ${metrics.queryCount} · frequent terms: ${metrics.topTerms.map((t) => t.term).join(', ') || '(none)'} · frequent pages: ${metrics.topPages.map((p) => p.slug).join(', ') || '(none)'}`,
      '',
      `# Today's conversations`,
      qa,
    ].join('\n');
  }
}
