import { Inject, Injectable } from '@nestjs/common';
import { BRAIN, BrainProvider, BrainResult } from '../brain/brain.port';
import { ConversationStore, ConversationRecord } from '../knowledge-core/conversation-store';
import { InsightStore, DayInsight } from '../knowledge-core/insight/insight-store';
import { computeDayMetrics, DayMetrics } from '../knowledge-core/insight/metrics';
import { loadPrompt } from './prompt-store';
import { PinoLogger } from '../pal/logger';
import { DEFAULT_USER } from '../pal/path-resolver';

// prompts/insight.md 없을 때의 내장 기본값(out-of-box 보장).
const INSIGHT_DEFAULT =
  '당신은 사용자의 하루 사용 기록을 분석하는 보조자다. 메트릭과 대화를 바탕으로 ' +
  '오늘 무엇에 집중했는지·관심 이동·미해결 질문을 3~5문장 한국어 서술로 요약하라. ' +
  '기록에 드러난 것만 적고, 목록이 아니라 문단으로.';

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
    this.logger.log(`인사이트 생성: ${day} (질의 ${metrics.queryCount}건)`, 'InsightReporter');
    return insight;
  }

  private buildPrompt(metrics: DayMetrics, records: ConversationRecord[]): string {
    const qa = records
      .map((r, i) => `${i + 1}. Q: ${r.question}\n   A: ${r.answer.slice(0, 200)}`)
      .join('\n');
    return [
      loadPrompt('insight', INSIGHT_DEFAULT),
      '',
      `# 메트릭`,
      `질의 ${metrics.queryCount}건 · 자주 쓴 단어: ${metrics.topTerms.map((t) => t.term).join(', ') || '(없음)'} · 자주 본 페이지: ${metrics.topPages.map((p) => p.slug).join(', ') || '(없음)'}`,
      '',
      `# 오늘 대화`,
      qa,
    ].join('\n');
  }
}
