import { ConversationRecord } from '../conversation-store';

export interface DayMetrics {
  date: string;                                   // YYYY-MM-DD (UTC)
  queryCount: number;
  hourHistogram: number[];                        // 길이 24, UTC 시간대별 질의 수
  avgQuestionLen: number;
  avgAnswerLen: number;
  topTerms: { term: string; count: number }[];    // 질문 토큰 빈도 TopN
  topPages: { slug: string; count: number }[];    // 인용 위키 slug 빈도 TopN
}

const TOP_N = 10;

// 한/영 최소 불용어. 형태소 분석 없이 공백/구두점 분리라 한국어 조사는 부분적으로만 걸러진다.
// ponytail: 단순 빈도 — 의미 군집은 두뇌 요약이 담당. 형태소 분석은 효용이 측정되면.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'with', 'it', 'this', 'that', 'i', 'you',
  '그', '이', '저', '것', '수', '등', '및', '를', '을', '은', '는', '뭐', '왜', '무엇', '어떻게',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)            // 문자/숫자 외(공백·구두점) 기준 분리(유니코드)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// 빈도 내림차순 → 동점은 키 오름차순(결정적). 상위 N.
function topEntries(counts: Map<string, number>, n: number): [string, number][] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
}

export function computeDayMetrics(date: string, records: ConversationRecord[]): DayMetrics {
  const hourHistogram = new Array<number>(24).fill(0);
  const termCounts = new Map<string, number>();
  const pageCounts = new Map<string, number>();
  let qLenSum = 0;
  let aLenSum = 0;

  for (const r of records) {
    const hour = new Date(r.ts).getUTCHours();
    if (hour >= 0 && hour < 24) hourHistogram[hour]++;
    qLenSum += r.question.length;
    aLenSum += r.answer.length;
    for (const t of tokenize(r.question)) termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
    for (const s of r.sources ?? []) pageCounts.set(s, (pageCounts.get(s) ?? 0) + 1);
  }

  const n = records.length;
  return {
    date,
    queryCount: n,
    hourHistogram,
    avgQuestionLen: n ? Math.round(qLenSum / n) : 0,
    avgAnswerLen: n ? Math.round(aLenSum / n) : 0,
    topTerms: topEntries(termCounts, TOP_N).map(([term, count]) => ({ term, count })),
    topPages: topEntries(pageCounts, TOP_N).map(([slug, count]) => ({ slug, count })),
  };
}
