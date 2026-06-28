# Phase 5A — InsightLayer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용 기록(ConversationStore)을 매일 한 번 결정적 메트릭 + 두뇌 서술로 정리해 `state/insights/`에 저장하고, 다음 ReaderAgent 답변에 "참고용" 맥락으로 주입한다.

**Architecture:** 순수 메트릭 함수(결정적) → InsightStore(JSON 영속) → InsightReporter(두뇌 1콜, agent-layer) → InsightContext(주입 문자열). 매일 `@Cron`(상주) 또는 `engram insights run`. ReaderAgent가 인용 slug를 콜백으로 노출 → Orchestrator.route가 대화기록 `sources`에 적재 → 인용 페이지 빈도 집계.

**Tech Stack:** NestJS · TypeScript · Jest · pino · 기존 BrainProvider 포트. **새 의존성 없음.**

**상위 기준선:** [spec](../specs/2026-06-28-phase5-insightlayer-pal-design.md) §2 · [DESIGN.md](../../DESIGN.md) §5.4

## Global Constraints

- 새 npm 의존성 금지(InsightLayer는 stdlib + 기존 포트로 충분).
- 모든 사용자 대면 문구는 한국어.
- 상주(main.ts)에서만 발화하는 컴포넌트(스케줄러)는 cli.ts 원샷에서 무발화여야 함(기존 DigestScheduler와 동일 성질).
- InsightLayer 미주입 상태에서도 ReaderAgent·CLI는 동작해야 함(`@Optional()` 주입, 빈 컨텍스트 폴백).
- ts: ISO UTC 문자열(`new Date().toISOString()`). 날짜 키·시간대 히스토그램은 UTC 기준.
- 테스트는 프레임워크 추가 없이 기존 Jest 패턴(`*.spec.ts`, `os.tmpdir()` 임시 디렉터리) 따름.

---

### Task 1: 코어 확장 — 경로·대화기록 필드·일별 읽기

**Files:**
- Modify: `src/pal/path-resolver.ts` (메서드 추가)
- Modify: `src/knowledge-core/conversation-store.ts` (필드 + 메서드 추가)
- Test: `src/pal/path-resolver.spec.ts`, `src/knowledge-core/conversation-store.spec.ts`

**Interfaces:**
- Consumes: 기존 `PathResolver.getStateDir()`, `ConversationStore`.
- Produces:
  - `PathResolver.getInsightsDir(userId?: string): string` → `<data>/state/insights/<userId>`
  - `ConversationRecord.sources?: string[]` (인용 위키 slug, 옵셔널·하위호환)
  - `ConversationStore.readDay(userId: string, day: string): Promise<ConversationRecord[]>`

- [ ] **Step 1: getInsightsDir 실패 테스트**

`src/pal/path-resolver.spec.ts`에 추가:

```ts
it('getInsightsDir는 state/insights/{userId} 경로를 준다', () => {
  const r = new PathResolver('/data');
  expect(r.getInsightsDir('default').replace(/\\/g, '/')).toBe('/data/state/insights/default');
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest path-resolver -t getInsightsDir`
Expected: FAIL — `getInsightsDir is not a function`

- [ ] **Step 3: getInsightsDir 구현**

`src/pal/path-resolver.ts`의 `getProjectsDir()` 아래에 추가:

```ts
  // 일일 인사이트(Phase 5) 저장 디렉터리. state/insights/{userId}/{day}.json.
  getInsightsDir(userId: string = DEFAULT_USER): string {
    return path.join(this.getStateDir(), 'insights', userId);
  }
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest path-resolver -t getInsightsDir`
Expected: PASS

- [ ] **Step 5: sources 필드 + readDay 실패 테스트**

`src/knowledge-core/conversation-store.spec.ts`에 추가:

```ts
it('readDay는 해당 날짜 기록만, sources 포함해 읽는다', async () => {
  const store = new ConversationStore(new PathResolver(dir));
  await store.append('default', { ts: '2026-06-28T01:00:00.000Z', question: 'q1', answer: 'a1', sources: ['s-a', 's-b'] });
  await store.append('default', { ts: '2026-06-29T01:00:00.000Z', question: 'q2', answer: 'a2' });
  const day = await store.readDay('default', '2026-06-28');
  expect(day.map((r) => r.question)).toEqual(['q1']);
  expect(day[0].sources).toEqual(['s-a', 's-b']);
});

it('readDay는 없는 날짜에 빈 배열', async () => {
  const store = new ConversationStore(new PathResolver(dir));
  expect(await store.readDay('default', '1999-01-01')).toEqual([]);
});
```

(`dir`은 기존 spec의 `beforeEach` 임시 디렉터리를 재사용. 없으면 상단 패턴 따라 `dir = await fs.mkdtemp(path.join(os.tmpdir(), 'conv-'))` 추가.)

- [ ] **Step 6: 실패 확인**

Run: `npx jest conversation-store -t readDay`
Expected: FAIL — `readDay is not a function`

- [ ] **Step 7: sources 필드 + readDay 구현**

`src/knowledge-core/conversation-store.ts`에서 인터페이스 확장:

```ts
export interface ConversationRecord { ts: string; question: string; answer: string; sources?: string[] }
```

`since()` 아래에 메서드 추가:

```ts
  // 특정 날짜(YYYY-MM-DD) 한 파일만 읽는다(인사이트 일일 집계용 — 전체 스캔 회피).
  async readDay(userId: string = DEFAULT_USER, day: string): Promise<ConversationRecord[]> {
    const file = path.join(this.convDir(userId), `${day}.jsonl`);
    let text: string;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const out: ConversationRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as ConversationRecord); } catch { continue; } // 손상 줄 건너뜀
    }
    return out;
  }
```

- [ ] **Step 8: 통과 확인**

Run: `npx jest conversation-store path-resolver`
Expected: PASS (전체)

- [ ] **Step 9: 커밋**

```bash
git add src/pal/path-resolver.ts src/pal/path-resolver.spec.ts src/knowledge-core/conversation-store.ts src/knowledge-core/conversation-store.spec.ts
git commit -m "feat(phase5a): 인사이트 경로·대화기록 sources·readDay 코어 확장"
```

---

### Task 2: 메트릭 집계 (순수 함수, 결정적)

**Files:**
- Create: `src/knowledge-core/insight/metrics.ts`
- Test: `src/knowledge-core/insight/metrics.spec.ts`

**Interfaces:**
- Consumes: `ConversationRecord`(T1, `sources?` 포함).
- Produces:
  - `interface DayMetrics { date: string; queryCount: number; hourHistogram: number[]; avgQuestionLen: number; avgAnswerLen: number; topTerms: {term:string;count:number}[]; topPages: {slug:string;count:number}[] }`
  - `computeDayMetrics(date: string, records: ConversationRecord[]): DayMetrics`

- [ ] **Step 1: 실패 테스트**

`src/knowledge-core/insight/metrics.spec.ts`:

```ts
import { computeDayMetrics } from './metrics';
import { ConversationRecord } from '../conversation-store';

const rec = (ts: string, q: string, a: string, sources?: string[]): ConversationRecord => ({ ts, question: q, answer: a, sources });

describe('computeDayMetrics', () => {
  it('빈 입력은 0 메트릭', () => {
    const m = computeDayMetrics('2026-06-28', []);
    expect(m.queryCount).toBe(0);
    expect(m.hourHistogram).toHaveLength(24);
    expect(m.hourHistogram.every((h) => h === 0)).toBe(true);
    expect(m.topTerms).toEqual([]);
    expect(m.topPages).toEqual([]);
  });

  it('카운트·시간대·평균길이·용어/페이지 빈도를 집계', () => {
    const m = computeDayMetrics('2026-06-28', [
      rec('2026-06-28T01:00:00.000Z', 'docker 배포 docker', 'aaaa', ['guide', 'deploy']),
      rec('2026-06-28T01:30:00.000Z', 'docker 환경변수', 'bb', ['guide']),
    ]);
    expect(m.queryCount).toBe(2);
    expect(m.hourHistogram[1]).toBe(2);          // 01시 UTC 2건
    expect(m.avgAnswerLen).toBe(3);              // (4+2)/2
    expect(m.topTerms[0]).toEqual({ term: 'docker', count: 3 }); // 빈도 최상
    expect(m.topPages[0]).toEqual({ slug: 'guide', count: 2 });  // 인용 최다
  });

  it('동점은 키 오름차순으로 안정 정렬(결정적)', () => {
    const m = computeDayMetrics('2026-06-28', [rec('2026-06-28T00:00:00.000Z', 'beta alpha', 'x')]);
    expect(m.topTerms.map((t) => t.term)).toEqual(['alpha', 'beta']);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest metrics`
Expected: FAIL — `Cannot find module './metrics'`

- [ ] **Step 3: 구현**

`src/knowledge-core/insight/metrics.ts`:

```ts
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
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest metrics`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/knowledge-core/insight/metrics.ts src/knowledge-core/insight/metrics.spec.ts
git commit -m "feat(phase5a): 결정적 일일 메트릭 집계(질의·시간대·용어·인용페이지)"
```

---

### Task 3: InsightStore (JSON 영속) + 모듈 등록

**Files:**
- Create: `src/knowledge-core/insight/insight-store.ts`
- Test: `src/knowledge-core/insight/insight-store.spec.ts`
- Modify: `src/knowledge-core/knowledge-core.module.ts` (provider + export)

**Interfaces:**
- Consumes: `PathResolver.getInsightsDir`(T1), `DayMetrics`(T2).
- Produces:
  - `interface DayInsight { date: string; metrics: DayMetrics; report: string }`
  - `InsightStore.save(userId: string, insight: DayInsight): Promise<void>`
  - `InsightStore.latest(userId?: string): Promise<DayInsight | null>`
  - `InsightStore.get(userId: string, date: string): Promise<DayInsight | null>`

- [ ] **Step 1: 실패 테스트**

`src/knowledge-core/insight/insight-store.spec.ts`:

```ts
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { InsightStore, DayInsight } from './insight-store';
import { PathResolver } from '../../pal/path-resolver';

const insight = (date: string): DayInsight => ({
  date,
  metrics: { date, queryCount: 1, hourHistogram: new Array(24).fill(0), avgQuestionLen: 1, avgAnswerLen: 1, topTerms: [], topPages: [] },
  report: `report-${date}`,
});

describe('InsightStore', () => {
  let dir: string; let store: InsightStore;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'insight-'));
    store = new InsightStore(new PathResolver(dir));
  });

  it('save→latest 라운드트립, 최신 날짜 반환', async () => {
    await store.save('default', insight('2026-06-27'));
    await store.save('default', insight('2026-06-28'));
    const latest = await store.latest('default');
    expect(latest?.date).toBe('2026-06-28');
    expect(latest?.report).toBe('report-2026-06-28');
  });

  it('없으면 latest는 null', async () => {
    expect(await store.latest('default')).toBeNull();
  });

  it('get은 특정 날짜를 반환', async () => {
    await store.save('default', insight('2026-06-28'));
    expect((await store.get('default', '2026-06-28'))?.report).toBe('report-2026-06-28');
    expect(await store.get('default', '2026-06-01')).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest insight-store`
Expected: FAIL — `Cannot find module './insight-store'`

- [ ] **Step 3: 구현**

`src/knowledge-core/insight/insight-store.ts`:

```ts
import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PathResolver, DEFAULT_USER } from '../../pal/path-resolver';
import { DayMetrics } from './metrics';

export interface DayInsight {
  date: string;        // YYYY-MM-DD
  metrics: DayMetrics;
  report: string;      // 두뇌 서술 요약
}

// 일일 인사이트 영속(설계 §5.4·spec A2). state/insights/{userId}/{day}.json — 위키 밖 운영 데이터.
@Injectable()
export class InsightStore {
  constructor(private readonly paths: PathResolver) {}

  async save(userId: string = DEFAULT_USER, insight: DayInsight): Promise<void> {
    const dir = this.paths.getInsightsDir(userId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${insight.date}.json`), JSON.stringify(insight, null, 2));
  }

  async latest(userId: string = DEFAULT_USER): Promise<DayInsight | null> {
    const files = await this.listDays(userId);
    if (files.length === 0) return null;
    return this.readFile(userId, files[files.length - 1]); // 파일명 정렬 = 날짜 오름차순
  }

  async get(userId: string = DEFAULT_USER, date: string): Promise<DayInsight | null> {
    return this.readFile(userId, `${date}.json`);
  }

  private async listDays(userId: string): Promise<string[]> {
    try { return (await fs.readdir(this.paths.getInsightsDir(userId))).filter((f) => f.endsWith('.json')).sort(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  }

  private async readFile(userId: string, name: string): Promise<DayInsight | null> {
    try { return JSON.parse(await fs.readFile(path.join(this.paths.getInsightsDir(userId), name), 'utf8')) as DayInsight; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest insight-store`
Expected: PASS

- [ ] **Step 5: 모듈 등록**

`src/knowledge-core/knowledge-core.module.ts`:
- 상단 import 추가: `import { InsightStore } from './insight/insight-store';`
- `providers` 배열에 추가:

```ts
    { provide: InsightStore, useFactory: (paths: PathResolver) => new InsightStore(paths), inject: [PathResolver] },
```

- `exports` 배열 끝에 `InsightStore` 추가.

- [ ] **Step 6: 모듈 컴파일 확인**

Run: `npx jest knowledge-core.module`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add src/knowledge-core/insight/insight-store.ts src/knowledge-core/insight/insight-store.spec.ts src/knowledge-core/knowledge-core.module.ts
git commit -m "feat(phase5a): InsightStore — 일일 인사이트 JSON 영속 + 모듈 등록"
```

---

### Task 4: InsightContext (주입 문자열) + 모듈 등록

**Files:**
- Create: `src/knowledge-core/insight/insight-context.ts`
- Test: `src/knowledge-core/insight/insight-context.spec.ts`
- Modify: `src/knowledge-core/knowledge-core.module.ts` (provider + export)

**Interfaces:**
- Consumes: `InsightStore`(T3).
- Produces: `InsightContext.latest(userId?: string): Promise<string>` (인사이트 없으면 `''`).

- [ ] **Step 1: 실패 테스트**

`src/knowledge-core/insight/insight-context.spec.ts`:

```ts
import { InsightContext } from './insight-context';
import { InsightStore, DayInsight } from './insight-store';

const fakeStore = (latest: DayInsight | null): InsightStore => ({ latest: async () => latest } as unknown as InsightStore);

describe('InsightContext', () => {
  it('인사이트 없으면 빈 문자열', async () => {
    const ctx = new InsightContext(fakeStore(null));
    expect(await ctx.latest('default')).toBe('');
  });

  it('있으면 날짜·리포트·주제를 담은 문자열', async () => {
    const ctx = new InsightContext(fakeStore({
      date: '2026-06-28',
      metrics: { date: '2026-06-28', queryCount: 3, hourHistogram: [], avgQuestionLen: 0, avgAnswerLen: 0, topTerms: [{ term: 'docker', count: 3 }], topPages: [] },
      report: '도커 배포에 집중',
    }));
    const out = await ctx.latest('default');
    expect(out).toContain('2026-06-28');
    expect(out).toContain('도커 배포에 집중');
    expect(out).toContain('docker');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest insight-context`
Expected: FAIL — `Cannot find module './insight-context'`

- [ ] **Step 3: 구현**

`src/knowledge-core/insight/insight-context.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { InsightStore } from './insight-store';
import { DEFAULT_USER } from '../../pal/path-resolver';

// 최신 인사이트를 ReaderAgent 주입용 짧은 문자열로(설계 §5.4·spec A3). 없으면 ''.
@Injectable()
export class InsightContext {
  constructor(private readonly store: InsightStore) {}

  async latest(userId: string = DEFAULT_USER): Promise<string> {
    const ins = await this.store.latest(userId);
    if (!ins) return '';
    const terms = ins.metrics.topTerms.slice(0, 5).map((t) => t.term).join(', ');
    return `(${ins.date} 기준) ${ins.report}${terms ? `\n자주 다룬 주제: ${terms}` : ''}`;
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest insight-context`
Expected: PASS

- [ ] **Step 5: 모듈 등록**

`src/knowledge-core/knowledge-core.module.ts`:
- import 추가: `import { InsightContext } from './insight/insight-context';`
- `providers`에 추가: `{ provide: InsightContext, useFactory: (store: InsightStore) => new InsightContext(store), inject: [InsightStore] },`
- `exports`에 `InsightContext` 추가.

- [ ] **Step 6: 컴파일 확인 + 커밋**

Run: `npx jest knowledge-core.module`
Expected: PASS

```bash
git add src/knowledge-core/insight/insight-context.ts src/knowledge-core/insight/insight-context.spec.ts src/knowledge-core/knowledge-core.module.ts
git commit -m "feat(phase5a): InsightContext — 응답 주입용 맥락 문자열 + 모듈 등록"
```

---

### Task 5: InsightReporter (두뇌 1콜) + 프롬프트 외부화 + 모듈 등록

**Files:**
- Create: `src/agent-layer/insight-reporter.ts`
- Create: `prompts/insight.md`
- Test: `src/agent-layer/insight-reporter.spec.ts`
- Modify: `src/agent-layer/agent-layer.module.ts` (provider)

**Interfaces:**
- Consumes: `ConversationStore.readDay`(T1), `computeDayMetrics`(T2), `InsightStore.save`(T3), `BrainProvider.complete`, `loadPrompt`(기존 `agent-layer/prompt-store.ts`), `PinoLogger`.
- Produces: `InsightReporter.run(userId?: string, date?: string): Promise<DayInsight | null>` (그날 대화 없으면 `null`).

- [ ] **Step 1: 프롬프트 파일 작성**

`prompts/insight.md`:

```markdown
당신은 사용자의 하루 사용 기록을 분석하는 보조자다. 아래 메트릭과 대화를 바탕으로, 사용자가 오늘 무엇에 집중했는지·관심이 어디로 움직이는지·아직 풀리지 않은 질문이 무엇인지 3~5문장의 한국어 서술로 요약하라. 추측을 단정하지 말고 기록에 드러난 것만 적어라. 목록이 아니라 자연스러운 문단으로.
```

- [ ] **Step 2: 실패 테스트**

`src/agent-layer/insight-reporter.spec.ts`:

```ts
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { InsightReporter } from './insight-reporter';
import { ConversationStore } from '../knowledge-core/conversation-store';
import { InsightStore } from '../knowledge-core/insight/insight-store';
import { PathResolver } from '../pal/path-resolver';
import { PinoLogger } from '../pal/logger';
import { BrainProvider } from '../brain/brain.port';

const okBrain = (text: string): BrainProvider => ({ complete: async () => ({ text, costUsd: 0, isError: false }) });
const errBrain = (): BrainProvider => ({ complete: async () => ({ text: '', costUsd: 0, isError: true }) });

describe('InsightReporter', () => {
  let dir: string; let conv: ConversationStore; let store: InsightStore; let logger: PinoLogger;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reporter-'));
    const paths = new PathResolver(dir);
    conv = new ConversationStore(paths);
    store = new InsightStore(paths);
    logger = new PinoLogger(paths);
  });

  it('그날 대화가 없으면 null, 저장도 안 함', async () => {
    const r = new InsightReporter(conv, store, okBrain('x'), logger);
    expect(await r.run('default', '2026-06-28')).toBeNull();
    expect(await store.latest('default')).toBeNull();
  });

  it('대화가 있으면 메트릭+리포트를 만들어 저장', async () => {
    await conv.append('default', { ts: '2026-06-28T01:00:00.000Z', question: 'docker 배포', answer: 'a', sources: ['guide'] });
    const r = new InsightReporter(conv, store, okBrain('오늘은 도커에 집중'), logger);
    const ins = await r.run('default', '2026-06-28');
    expect(ins?.report).toBe('오늘은 도커에 집중');
    expect(ins?.metrics.queryCount).toBe(1);
    expect(ins?.metrics.topPages[0].slug).toBe('guide');
    expect((await store.latest('default'))?.date).toBe('2026-06-28');
  });

  it('두뇌 오류면 리포트는 실패 표식이되 메트릭은 저장', async () => {
    await conv.append('default', { ts: '2026-06-28T01:00:00.000Z', question: 'q', answer: 'a' });
    const r = new InsightReporter(conv, store, errBrain(), logger);
    const ins = await r.run('default', '2026-06-28');
    expect(ins?.report).toContain('실패');
    expect(ins?.metrics.queryCount).toBe(1);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest insight-reporter`
Expected: FAIL — `Cannot find module './insight-reporter'`

- [ ] **Step 4: 구현**

`src/agent-layer/insight-reporter.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { BRAIN, BrainProvider } from '../brain/brain.port';
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
    const result = await this.brain.complete(this.buildPrompt(metrics, records));
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
```

- [ ] **Step 5: 통과 확인**

Run: `npx jest insight-reporter`
Expected: PASS

- [ ] **Step 6: 모듈 등록**

`src/agent-layer/agent-layer.module.ts`:
- import 추가: `import { InsightReporter } from './insight-reporter';`
- `providers` 배열에 `InsightReporter` 추가(평범한 `@Injectable` — Nest 자동 해소; `ConversationStore`·`InsightStore`는 KnowledgeCore export, `BRAIN`은 BrainModule).

- [ ] **Step 7: 커밋**

```bash
git add src/agent-layer/insight-reporter.ts src/agent-layer/insight-reporter.spec.ts prompts/insight.md src/agent-layer/agent-layer.module.ts
git commit -m "feat(phase5a): InsightReporter — 메트릭+두뇌 일일 리포트 생성 + prompts/insight.md"
```

---

### Task 6: ReaderAgent — 인용 slug 노출 + 맥락 주입

**Files:**
- Modify: `src/agent-layer/reader-agent.ts`
- Test: `src/agent-layer/reader-agent.spec.ts`

**Interfaces:**
- Consumes: `InsightContext.latest`(T4, `@Optional()`), 기존 `RagStore.search`·`BrainProvider`.
- Produces: `ReaderAgent.handle(msg, onChunk?, onSources?: (slugs: string[]) => void)` — hits의 slug를 `onSources`로 노출; InsightContext 주입 시 프롬프트에 `# 참고용 사용자 맥락` 섹션 추가.

- [ ] **Step 1: 실패 테스트**

`src/agent-layer/reader-agent.spec.ts`에 추가(기존 spec의 rag/brain 목 패턴 재사용; 없으면 아래 자립 목 사용):

```ts
import { ReaderAgent } from './reader-agent';
import { RagStore } from '../knowledge-core/rag/rag-store';
import { PinoLogger } from '../pal/logger';
import { InsightContext } from '../knowledge-core/insight/insight-context';
import { PathResolver } from '../pal/path-resolver';

const ragWith = (hits: { slug: string; title: string; text: string }[]): RagStore =>
  ({ search: async () => hits } as unknown as RagStore);
const brainEcho = (capture?: (p: string) => void) => ({
  complete: async (prompt: string) => { capture?.(prompt); return { text: '답', costUsd: 0, isError: false }; },
});

describe('ReaderAgent 인사이트 주입', () => {
  const logger = new PinoLogger(new PathResolver(require('os').tmpdir()));

  it('onSources로 인용 slug를 노출한다', async () => {
    let slugs: string[] = [];
    const reader = new ReaderAgent(ragWith([{ slug: 's1', title: 'T', text: 'x' }]), brainEcho() as any, logger);
    await reader.handle({ text: 'q', userId: 'default' }, undefined, (s) => { slugs = s; });
    expect(slugs).toEqual(['s1']);
  });

  it('InsightContext 주입 시 참고용 섹션을 프롬프트에 넣는다', async () => {
    let prompt = '';
    const ctx = { latest: async () => '(2026-06-28 기준) 도커 집중' } as unknown as InsightContext;
    const reader = new ReaderAgent(ragWith([]), brainEcho((p) => { prompt = p; }) as any, logger, ctx);
    await reader.handle({ text: 'q', userId: 'default' });
    expect(prompt).toContain('참고용 사용자 맥락');
    expect(prompt).toContain('도커 집중');
  });

  it('InsightContext 없으면 참고용 섹션이 없다', async () => {
    let prompt = '';
    const reader = new ReaderAgent(ragWith([]), brainEcho((p) => { prompt = p; }) as any, logger);
    await reader.handle({ text: 'q', userId: 'default' });
    expect(prompt).not.toContain('참고용 사용자 맥락');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest reader-agent -t 인사이트`
Expected: FAIL — `handle` 3번째 인자 미지원 / 생성자 4번째 인자 미지원

- [ ] **Step 3: 구현**

`src/agent-layer/reader-agent.ts` 수정:

생성자에 `@Optional()` InsightContext 추가(import: `import { Optional } from '@nestjs/common';`, `import { InsightContext } from '../knowledge-core/insight/insight-context';`):

```ts
  constructor(
    private readonly rag: RagStore,
    @Inject(BRAIN) private readonly brain: BrainProvider,
    private readonly logger: PinoLogger,
    @Optional() private readonly insight?: InsightContext,
  ) {}
```

`handle` 시그니처·본문 수정:

```ts
  async handle(
    msg: CoreMessage,
    onChunk?: (t: string) => void,
    onSources?: (slugs: string[]) => void,
  ): Promise<string> {
    const emit = (s: string): void => onChunk?.(s);
    try {
      const hits = await this.rag.search(msg.text, 5, msg.userId);
      onSources?.(hits.map((h) => h.slug));
      const header = hits.length === 0 ? NO_HITS_HEADER : '';
      if (header) emit(header);

      const ctx = this.insight ? await this.insight.latest(msg.userId) : '';
      const result = await this.brain.complete(this.buildPrompt(msg.text, hits, ctx), onChunk);
      if (result.isError) {
        const m = '답변 생성 실패: 두뇌 호출 오류';
        emit(m);
        return header + m;
      }

      const sources = hits.length
        ? `\n\n───\n출처: ${hits.map((h, i) => `[${i + 1}] ${h.title} (${h.slug})`).join(' · ')}`
        : '';
      if (sources) emit(sources);
      return header + result.text + sources;
    } catch (err) {
      this.logger.error('ReaderAgent.handle 실패', String(err), 'ReaderAgent');
      const m = `답변 생성 실패: ${String(err)}`;
      emit(m);
      return m;
    }
  }
```

`buildPrompt`에 ctx 파라미터 추가(참고용 섹션은 ctx 있을 때만):

```ts
  private buildPrompt(question: string, hits: SearchResult[], ctx = ''): string {
    const context = hits.map((h, i) => `[${i + 1}] ${h.title} (slug: ${h.slug})\n${h.text}`).join('\n\n');
    const insightBlock = ctx
      ? `# 참고용 사용자 맥락 (답의 근거 아님 — 근거는 아래 위키)\n${ctx}\n\n`
      : '';
    return [
      '아래 검색된 위키 내용을 우선 근거로 질문에 답하라.',
      '사용한 근거는 [n]으로 표기하라. 검색 내용으로 답할 수 없으면 위키 밖 일반 지식임을 명시하라.',
      '',
      insightBlock + `# 검색된 위키\n${context || '(없음)'}`,
      '',
      `# 질문\n${question}`,
    ].join('\n');
  }
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest reader-agent`
Expected: PASS (신규 + 기존 전부 — 기존 호출은 onSources 생략·ctx 기본값으로 무영향)

- [ ] **Step 5: 커밋**

```bash
git add src/agent-layer/reader-agent.ts src/agent-layer/reader-agent.spec.ts
git commit -m "feat(phase5a): ReaderAgent 인용 slug 노출 + 인사이트 맥락 참고용 주입"
```

---

### Task 7: Orchestrator — sources 적재 + insight() 위임

**Files:**
- Modify: `src/agent-layer/orchestrator.ts`
- Modify: `src/agent-layer/agent-layer.module.ts` (Orchestrator 팩토리에 reporter 주입)
- Test: `src/agent-layer/orchestrator.spec.ts`

**Interfaces:**
- Consumes: `ReaderAgent.handle(.., onSources)`(T6), `InsightReporter.run`(T5, `@Optional()`).
- Produces:
  - `Orchestrator.route()`가 인용 slug를 `ConversationStore.append({.., sources})`에 실음.
  - `Orchestrator.insight(userId?): Promise<DayInsight | null>` (reporter 위임; 미주입 시 throw).

- [ ] **Step 1: 실패 테스트**

`src/agent-layer/orchestrator.spec.ts`에 추가(기존 spec의 목 구성 재사용):

```ts
it('route는 reader가 노출한 인용 slug를 대화기록 sources에 적재한다', async () => {
  // reader 목: onSources 콜백으로 ['p1','p2'] 노출
  const reader = { handle: async (_m: any, _c: any, onSources?: (s: string[]) => void) => { onSources?.(['p1', 'p2']); return '답'; } };
  const appended: any[] = [];
  const conversations = { append: async (_u: string, rec: any) => { appended.push(rec); } };
  const orch = new Orchestrator(reader as any, conversations as any, logger as any, ingester as any);
  await orch.route({ text: 'q', userId: 'default' });
  expect(appended[0].sources).toEqual(['p1', 'p2']);
});

it('insight()는 reporter에 위임한다', async () => {
  const reporter = { run: async () => ({ date: '2026-06-28', metrics: {} as any, report: 'r' }) };
  const orch = new Orchestrator(
    reader as any, conversations as any, logger as any, ingester as any,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reporter as any,
  );
  expect((await orch.insight('default'))?.report).toBe('r');
});
```

(기존 spec 상단의 `reader/conversations/logger/ingester` 목·`Orchestrator` import를 재사용. `insight()` 테스트의 위치인자 개수는 생성자 순서와 정확히 일치해야 함 — 아래 Step 3 생성자 참조.)

- [ ] **Step 2: 실패 확인**

Run: `npx jest orchestrator -t insight`
Expected: FAIL — `insight is not a function` / sources 미적재

- [ ] **Step 3: 구현**

`src/agent-layer/orchestrator.ts`:

상단 import 추가:

```ts
import { InsightReporter } from './insight-reporter';
import { DayInsight } from '../knowledge-core/insight/insight-store';
```

생성자 맨 끝에 `@Optional()` reporter 추가(기존 `fence?` 다음, 16번째 인자):

```ts
    @Optional() private readonly fence?: PermissionFence,
    @Optional() private readonly reporter?: InsightReporter,
  ) {}
```

`route()`에서 slug 캡처:

```ts
  async route(msg: CoreMessage, onChunk?: (t: string) => void): Promise<string> {
    let sources: string[] = [];
    const answer = await this.reader.handle(msg, onChunk, (s) => { sources = s; });
    try {
      await this.conversations.append(msg.userId, {
        ts: new Date().toISOString(), question: msg.text, answer, sources,
      });
    } catch (err) {
      this.logger.warn(`대화 적재 실패(답변은 정상 반환): ${String(err)}`, 'Orchestrator');
    }
    return answer;
  }
```

`digest()` 아래에 `insight()` 추가:

```ts
  // 일일 인사이트 생성(설계 §5.4). DigestScheduler→digest와 동렬: 스케줄러·CLI가 호출.
  insight(userId: string = DEFAULT_USER): Promise<DayInsight | null> {
    if (!this.reporter) throw new Error('InsightReporter 미주입(Orchestrator)');
    return this.reporter.run(userId);
  }
```

`src/agent-layer/agent-layer.module.ts` Orchestrator 팩토리 수정:
- import 추가: `import { InsightReporter } from './insight-reporter';`
- useFactory 인자 끝에 `reporter: InsightReporter` 추가, `new Orchestrator(...)` 호출 끝에 `reporter` 전달:

```ts
      useFactory: (
        reader: ReaderAgent, conversations: ConversationStore, logger: PinoLogger, ingester: IngesterAgent,
        tasks: TaskStore, specialist: SpecialistAgent, synthesizer: Synthesizer, projects: ProjectStore,
        gate: VerificationGate, codingGit: CodingGit, coder: CodingSpecialist, reviewer: ReviewerAgent,
        codeBrain: BrainProvider, fence: PermissionFence, reporter: InsightReporter,
      ) => {
        const sem = new Semaphore(2);
        return new Orchestrator(
          reader, conversations, logger, ingester, tasks, specialist, synthesizer, sem,
          projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter,
        );
      },
      inject: [
        ReaderAgent, ConversationStore, PinoLogger, IngesterAgent, TaskStore,
        SpecialistAgent, Synthesizer, ProjectStore, VerificationGate, CodingGit, CodingSpecialist, ReviewerAgent,
        BRAIN, PermissionFence, InsightReporter,
      ],
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest orchestrator`
Expected: PASS (신규 + 기존 — 기존 `route` 테스트는 sources가 추가돼도 append record에 무관한 필드라면 통과; 기존 단언이 record 전체 동등비교라면 `sources: []` 포함하도록 그 단언만 갱신)

- [ ] **Step 5: 커밋**

```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator.spec.ts src/agent-layer/agent-layer.module.ts
git commit -m "feat(phase5a): Orchestrator sources 적재 + insight() 위임"
```

---

### Task 8: InsightScheduler (@Cron) + resolveCron 기본값 파라미터화

**Files:**
- Modify: `src/edge/digest.scheduler.ts` (`resolveCron`에 def 파라미터 추가)
- Create: `src/edge/insight.scheduler.ts`
- Test: `src/edge/digest.scheduler.spec.ts` (resolveCron 기본값), `src/edge/insight.scheduler.spec.ts`
- Modify: `src/edge/edge.module.ts` (provider 등록)

**Interfaces:**
- Consumes: `Orchestrator.insight`(T7), `resolveCron`(확장), `PinoLogger`.
- Produces: `InsightScheduler.tick()` — 상주에서 `@Cron`으로 일일 발화. `resolveCron(raw, def?)`.

- [ ] **Step 1: resolveCron 기본값 테스트**

`src/edge/digest.scheduler.spec.ts`에 추가:

```ts
it('resolveCron은 def 인자로 기본값을 바꿀 수 있다', () => {
  expect(resolveCron(undefined, '0 4 * * *')).toBe('0 4 * * *');
  expect(resolveCron('잘못된 문구', '0 4 * * *')).toBe('0 4 * * *');
  expect(resolveCron('0 9 * * *', '0 4 * * *')).toBe('0 9 * * *');
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest digest.scheduler -t def`
Expected: FAIL — 2번째 인자 무시되어 `'0 3 * * *'` 반환

- [ ] **Step 3: resolveCron 확장**

`src/edge/digest.scheduler.ts`:

```ts
export function resolveCron(raw: string | undefined, def = '0 3 * * *'): string {
  if (!raw) return def;
  const n = raw.trim().split(/\s+/).length;
  return n === 5 || n === 6 ? raw.trim() : def;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest digest.scheduler`
Expected: PASS (기존 + 신규)

- [ ] **Step 5: InsightScheduler 테스트**

`src/edge/insight.scheduler.spec.ts`:

```ts
import { InsightScheduler } from './insight.scheduler';
import { PinoLogger } from '../pal/logger';
import { PathResolver } from '../pal/path-resolver';

describe('InsightScheduler', () => {
  const logger = new PinoLogger(new PathResolver(require('os').tmpdir()));

  it('tick은 orchestrator.insight를 호출한다', async () => {
    let called = false;
    const orch = { insight: async () => { called = true; return { date: '2026-06-28', metrics: {} as any, report: 'r' }; } };
    await new InsightScheduler(orch as any, logger).tick();
    expect(called).toBe(true);
  });

  it('insight 예외가 프로세스를 죽이지 않는다(로깅 후 정상 반환)', async () => {
    const orch = { insight: async () => { throw new Error('boom'); } };
    await expect(new InsightScheduler(orch as any, logger).tick()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 6: 실패 확인**

Run: `npx jest insight.scheduler`
Expected: FAIL — `Cannot find module './insight.scheduler'`

- [ ] **Step 7: 구현**

`src/edge/insight.scheduler.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Orchestrator } from '../agent-layer/orchestrator';
import { PinoLogger } from '../pal/logger';
import { DEFAULT_USER } from '../pal/path-resolver';
import { resolveCron } from './digest.scheduler';

// 다이제스트(03:00) 뒤 04:00 기본. DigestScheduler와 동일 성질(상주에서만 발화, cli.ts 원샷은 무발화).
const INSIGHT_CRON = resolveCron(process.env.ENGRAM_INSIGHT_CRON, '0 4 * * *');

@Injectable()
export class InsightScheduler {
  constructor(private readonly orchestrator: Orchestrator, private readonly logger: PinoLogger) {}

  @Cron(INSIGHT_CRON)
  async tick(): Promise<void> {
    try {
      const ins = await this.orchestrator.insight(DEFAULT_USER);
      this.logger.log(ins ? `인사이트 생성: ${ins.date}` : '인사이트 생략(대화 없음)', 'InsightScheduler');
    } catch (err) {
      this.logger.error('InsightScheduler.tick 실패', String(err), 'InsightScheduler');
    }
  }
}
```

- [ ] **Step 8: 모듈 등록 + 통과 확인**

`src/edge/edge.module.ts`:
- import 추가: `import { InsightScheduler } from './insight.scheduler';`
- `providers`에 `InsightScheduler` 추가.

Run: `npx jest insight.scheduler digest.scheduler`
Expected: PASS

- [ ] **Step 9: 커밋**

```bash
git add src/edge/digest.scheduler.ts src/edge/digest.scheduler.spec.ts src/edge/insight.scheduler.ts src/edge/insight.scheduler.spec.ts src/edge/edge.module.ts
git commit -m "feat(phase5a): InsightScheduler @Cron + resolveCron 기본값 파라미터화"
```

---

### Task 9: CLI — engram insights [run]

**Files:**
- Modify: `src/edge/cli.gateway.ts`
- Test: `src/edge/cli.gateway.spec.ts`

**Interfaces:**
- Consumes: `Orchestrator.insight`(T7), `InsightStore.latest`(T3, `@Optional()`).
- Produces: `engram insights` (최신 리포트 출력), `engram insights run` (즉시 생성). 사용법 문자열에 추가.

- [ ] **Step 1: 실패 테스트**

`src/edge/cli.gateway.spec.ts`에 추가(기존 spec의 출력 캡처 패턴 재사용; orchestrator·proposals·applier 목 구성):

```ts
it('insights run은 orchestrator.insight를 호출하고 생성 결과를 출력', async () => {
  const out: string[] = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out.push(String(s)); return true; });
  const orch = { insight: async () => ({ date: '2026-06-28', metrics: {} as any, report: '도커 집중' }) };
  const gw = new CliGateway(orch as any, {} as any, {} as any);
  await gw.run(['insights', 'run']);
  expect(out.join('')).toContain('2026-06-28');
  (process.stdout.write as any).mockRestore();
});

it('insights는 InsightStore.latest를 출력(없으면 안내)', async () => {
  const out: string[] = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out.push(String(s)); return true; });
  const store = { latest: async () => null };
  const gw = new CliGateway({} as any, {} as any, {} as any, undefined, undefined, store as any);
  await gw.run(['insights']);
  expect(out.join('')).toContain('아직');
  (process.stdout.write as any).mockRestore();
});
```

(주의: `CliGateway` 생성자 인자 개수는 Step 3에서 추가하는 `@Optional() insights?` 위치와 일치해야 함.)

- [ ] **Step 2: 실패 확인**

Run: `npx jest cli.gateway -t insights`
Expected: FAIL — `insights` 분기 없음 / 생성자 인자 부족

- [ ] **Step 3: 구현**

`src/edge/cli.gateway.ts`:
- import 추가: `import { InsightStore } from '../knowledge-core/insight/insight-store';`
- 생성자에 `@Optional()` 마지막 인자 추가:

```ts
    @Optional() private readonly meetingEngine?: MeetingEngine,
    @Optional() private readonly insights?: InsightStore,
  ) {}
```

- `run()`의 디스패치 체인에 분기 추가(`else if (argv[0] === 'meeting')` 근처):

```ts
    } else if (argv[0] === 'insights') {
      if (argv[1] === 'run') {
        const ins = await this.orchestrator.insight(DEFAULT_USER);
        process.stdout.write(ins ? `인사이트 생성: ${ins.date} (질의 ${ins.metrics.queryCount}건)\n` : '대화 기록이 없어 생략\n');
      } else {
        const ins = this.insights ? await this.insights.latest(DEFAULT_USER) : null;
        process.stdout.write(ins ? `[${ins.date}]\n${ins.report}\n` : '인사이트가 아직 없습니다. engram insights run 으로 생성.\n');
      }
    }
```

- 사용법 문자열(맨 끝 `else` 블록)에 `| engram insights [run]` 추가.

- [ ] **Step 4: 통과 확인**

Run: `npx jest cli.gateway`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/edge/cli.gateway.ts src/edge/cli.gateway.spec.ts
git commit -m "feat(phase5a): engram insights [run] CLI"
```

---

### Task 10: 통합 스모크 + 빌드 검증

**Files:**
- Create: `src/agent-layer/insight.integration.spec.ts`
- (참조: 기존 `src/agent-layer/collaboration.integration.spec.ts` 패턴 — 실제 모듈 그래프를 FakeBrain·FakeEmbedder override로 띄움)

**Interfaces:**
- Consumes: 전체 모듈 그래프(AppModule 또는 KnowledgeCore+AgentLayer+Edge 테스트 구성).

- [ ] **Step 1: 통합 스모크 테스트 작성**

`src/agent-layer/insight.integration.spec.ts` (기존 integration spec의 Test.createTestingModule + FakeBrain/FakeEmbedder override 구성을 복제):

```ts
// 흐름: ask(대화 1건 적재, sources 포함) → insight run(메트릭+리포트 생성) → insights 조회 → 다음 ask 프롬프트에 참고용 주입.
it('ask → insight run → 조회 → 주입 전 과정이 동작한다', async () => {
  // 1) orchestrator.route로 질문 1건 → ConversationStore에 sources 포함 적재
  // 2) orchestrator.insight('default') → DayInsight 생성, store.latest 비어있지 않음
  // 3) InsightContext.latest('default') 비어있지 않음(리포트·주제 포함)
  // 4) (선택) ReaderAgent.handle이 참고용 섹션 포함 프롬프트로 두뇌 호출
  // 위 4단계를 실제 주입된 인스턴스로 단언.
});
```

(구체 어서션은 기존 integration spec의 모듈 부트스트랩 코드를 그대로 가져와 채운다 — FakeBrain은 고정 텍스트 반환, FakeEmbedder로 RAG 우회. 새 목 구조를 발명하지 말 것.)

- [ ] **Step 2: 통합 테스트 통과 확인**

Run: `npx jest insight.integration`
Expected: PASS

- [ ] **Step 3: 전체 테스트 + 빌드 + 린트**

Run: `npx jest && npx tsc --noEmit`
Expected: 전체 PASS, 타입 에러 0

(레포 스크립트가 있으면 그걸 우선: `npm test`, `npm run build`. package.json 확인.)

- [ ] **Step 4: 최종 커밋**

```bash
git add src/agent-layer/insight.integration.spec.ts
git commit -m "test(phase5a): InsightLayer 통합 스모크 — ask→생성→조회→주입"
```

---

## Self-Review (작성자 점검 결과)

- **스펙 커버리지(spec §2)**: A1 결정적 메트릭+두뇌 요약(T2·T5) · A2 state/insights + CLI(T3·T9) · A3 항상·구분 주입(T6) · A4 메트릭 4종 + 인용페이지(T2) · A5 sources 확장 + Orchestrator.route 경로(T1·T6·T7). 누락 없음.
- **PAL(spec §3)**: 이 플랜 범위 밖 — **Phase 5B 별도 플랜**(같은 spec, 다음 문서).
- **타입 일관성**: `DayMetrics`(T2)·`DayInsight`(T3)·`computeDayMetrics`(T2)·`InsightStore.{save,latest,get}`(T3)·`InsightContext.latest`(T4)·`InsightReporter.run`(T5)·`ReaderAgent.handle(.., onSources)`(T6)·`Orchestrator.insight`(T7) — 사용처와 정의 일치 확인.
- **플레이스홀더**: T10 통합 어서션은 "기존 integration spec 부트스트랩 복제"로 위임 — 실제 코드 본보기가 레포에 존재하므로 추상 지시 아님(기존 `collaboration.integration.spec.ts`·`coding.integration.spec.ts` 참조).
- **주의(구현자)**: 기존 `orchestrator.spec.ts`·`reader-agent.spec.ts`·`cli.gateway.spec.ts`의 **생성자 인자 개수**가 새 `@Optional()` 추가로 바뀌므로, 기존 테스트가 위치인자로 생성자를 호출하면 그 호출만 갱신(끝에 `undefined` 또는 새 목 추가). record 전체 동등비교 단언은 `sources: []` 포함하도록 갱신.
