# 언어 리팩터 Plan 2 — 백엔드 하드코딩 문자열 i18n (스코프 D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 백엔드가 코드로 직접 사용자에게 찍는 한국어 문자열(상태·안내·라벨·회의록·헤더·폴백)을 백엔드 T 사전(en/ko)으로 옮겨 설정 언어(`ENGRAM_LANG`)를 따르게 한다.

**Architecture:** Plan 1의 `configuredLang()`를 재사용하는 순수 `t(key, ...args)` 사전을 `src/agent-layer/i18n.ts`에 두고, chat/wiki에 나가는 80개 한국어 문자열을 `t('key', ...)` 호출로 교체한다. 미설정 언어=`en`(폴백), 그 외=en. 두뇌 코어·ws 프레임·저장 스키마 무변경.

**Tech Stack:** NestJS/TypeScript, jest.

## Global Constraints

- **설정 언어 소스 = `configuredLang()`**(Plan 1, `ENGRAM_LANG` env, 폴백 `en`). `t()`가 내부에서 읽는다 — 호출부는 lang 안 넘김.
- **Action `send` 값은 절대 안 바꾼다** — pending 상태머신이 리터럴 매칭(`'승인'`/`'취소'`/`'구현 시작'`/`'1'` 등). **`label`만** `t()`로 번역. send는 한국어 토큰 그대로.
- **입력 매처 유지**: `trimmed === '승인' || 'approve'`, `'예약목록'||'schedules'`, `startsWith('예약취소 ')||startsWith('schedule cancel ')` 등 한/영 이중 수용은 **그대로**(파서, 번역 아님).
- **안내문 속 명령어**: `resumeScheduled`/`collabRetryScheduled`의 en 버전은 `@Engram schedule cancel ${id}`(파서가 수용하는 영어형), ko 버전은 `@Engram 예약취소 ${id}`.
- **번역 금지(범위 밖, 그대로)**: LLM 프롬프트(Plan 1 완료), `this.logger.*` 로그, `throw new Error(...)` 예외, 코드 주석, `src/edge/cli.gateway.ts`(터미널 CLI — 별도 후속).
- **기본 언어가 `en`으로 바뀐다**: 미설정 시 백엔드 출력이 한국어→영어. 한국어 출력을 단언하던 기존 테스트는 **영어(기본 en)로 갱신**하거나 그 테스트에서 `process.env.ENGRAM_LANG='ko'` 설정. 의미 있는 단언 유지.
- 이모지·마크다운·화살표(📁⏸✅⚠️💡🙏▶🧑‍🤝‍🧑✔✗📝📋☀️───▲▼)와 보간 자리(`${…}`)는 en에도 보존.
- 테스트: `npx jest <spec>`. 한글 검사 `/[가-힣]/`.

---

## Task 1: `i18n.ts` — 백엔드 T 사전 + `t()` (순수)

**Files:**
- Create: `src/agent-layer/i18n.ts`
- Test: `src/agent-layer/i18n.spec.ts`

**Interfaces:**
- Consumes: `configuredLang` from `./language` (Plan 1).
- Produces: `t(key: string, ...args: any[]): string`. `// ponytail: args는 키별 타입체크 안 함 — 필요해지면 키별 타입 빌더로 승격.`

- [ ] **Step 1: 실패 테스트** — `src/agent-layer/i18n.spec.ts`

```ts
import { t } from './i18n';

describe('t()', () => {
  afterEach(() => { delete process.env.ENGRAM_LANG; });
  it('defaults to English when ENGRAM_LANG unset', () => {
    expect(t('cancelled')).toBe('Cancelled.');
  });
  it('returns Korean when ENGRAM_LANG=ko', () => {
    process.env.ENGRAM_LANG = 'ko';
    expect(t('cancelled')).toBe('취소했어요.');
  });
  it('falls back to English for an unsupported language', () => {
    process.env.ENGRAM_LANG = 'ja';
    expect(t('cancelled')).toBe('Cancelled.');
  });
  it('interpolates args', () => {
    expect(t('teamFormed', 'A·B')).toBe('Team: A·B — looking into it');
    process.env.ENGRAM_LANG = 'ko';
    expect(t('teamFormed', 'A·B')).toBe('팀 구성: A·B — 알아볼게요');
  });
  it('scheduleCreated once suffix', () => {
    expect(t('scheduleCreated', 3, '0 9 * * *', true)).toBe('Okay, scheduled 📅 (schedule #3, 0 9 * * *) — once');
    expect(t('scheduleCreated', 3, '0 9 * * *', false)).toBe('Okay, scheduled 📅 (schedule #3, 0 9 * * *)');
  });
  it('unknown key throws (dev guard)', () => {
    expect(() => t('___nope___')).toThrow();
  });
});
```

- [ ] **Step 2: 실패 확인** — `npx jest src/agent-layer/i18n.spec.ts` → FAIL

- [ ] **Step 3: 구현** — `src/agent-layer/i18n.ts`

```ts
import { configuredLang } from './language';

// 백엔드가 사용자(chat/wiki)에게 찍는 문자열 사전. 설정 언어(ENGRAM_LANG) 추종, 미지원=en 폴백.
// 각 키: { en, ko } 함수(무인자도 함수로 통일). 보간은 함수 인자.
// ponytail: args 키별 타입체크 안 함(any[]) — 필요해지면 키별 타입 빌더로 승격.
type Entry = { en: (...a: any[]) => string; ko: (...a: any[]) => string };

const onceEn = (o: boolean) => (o ? ' — once' : '');
const onceKo = (o: boolean) => (o ? ' — 1회' : '');

const MESSAGES: Record<string, Entry> = {
  // ── simple (no args) ──
  cancelled: { en: () => 'Cancelled.', ko: () => '취소했어요.' },
  scheduleNotReady: { en: () => "Scheduling isn't set up yet.", ko: () => '예약 기능이 준비되지 않았어요.' },
  scheduleNotFound: { en: () => "Couldn't find that schedule.", ko: () => '그 예약을 못 찾았어요.' },
  noRepoFolder: { en: () => "This channel doesn't have a working folder yet. Open the channel and pick a folder first 📁", ko: () => '이 채널엔 아직 작업 폴더가 없어요. 채널에 들어가 폴더를 먼저 선택해 주세요 📁' },
  collabFailedNeedHuman: { en: () => 'Something went wrong — a human needs to take a look 🙏', ko: () => '작업 중 문제가 생겼어요 — 사람이 봐야 해요 🙏' },
  collabFailed: { en: () => 'Something went wrong 🙏', ko: () => '작업 중 문제가 생겼어요 🙏' },
  answerUnavailable: { en: () => "Couldn't answer just now 🙏", ko: () => '지금 답하기 어려웠어요 🙏' },
  codingNotReady: { en: () => "Coding isn't set up yet.", ko: () => '코딩 기능이 준비되지 않았어요.' },
  pathProtected: { en: () => "Can't write there (protected path).", ko: () => '그 경로엔 쓸 수 없어요(보호 경로).' },
  projectNotFound: { en: () => "Couldn't find that project.", ko: () => '그 프로젝트를 못 찾았어요.' },
  projectNotApproved: { en: () => "That project hasn't been approved.", ko: () => '승인되지 않은 프로젝트예요.' },
  codingStarted: { en: () => "Starting autonomous coding. I'll post progress here.", ko: () => '자율 코딩 시작할게요. 진행은 여기 올릴게요.' },
  codingFailed: { en: () => 'Something went wrong while coding 🙏', ko: () => '코딩 중 문제가 생겼어요 🙏' },
  scheduleUnclear: { en: () => 'Not sure when you mean. Could you phrase it like "every day at 9am"?', ko: () => '언제인지 잘 모르겠어요. "매일 아침 9시"처럼 다시 말해줄래요?' },
  noSchedules: { en: () => 'No schedules.', ko: () => '예약이 없어요.' },
  noTasks: { en: () => 'No tasks currently running or recently completed.', ko: () => '지금 진행 중이거나 최근 완료한 작업이 없어요.' },
  synthesizingOpinions: { en: () => '📝 Synthesizing input…', ko: () => '📝 의견 종합 중…' },
  decomposing: { en: () => 'Breaking down the work… (calling the brain)', ko: () => '작업 분해 중… (두뇌 호출)' },
  reviewingCriteria: { en: () => 'Reviewing acceptance criteria…', ko: () => '완성조건 리뷰 중…' },
  criteriaMet: { en: () => '✓ Acceptance criteria met — done', ko: () => '✓ 완성조건 충족 — 완료' },
  criteriaMetStored: { en: () => 'Acceptance criteria met — awaiting human merge', ko: () => '완성조건 충족 — 사람 머지 대기' },
  startCodingConfirm: { en: () => 'Start autonomous coding?', ko: () => '자율 코딩을 시작할까요?' },
  // Action labels (send 값은 코드에 그대로, label만 여기)
  startImplementationLabel: { en: () => 'Start implementation', ko: () => '구현 시작' },
  cancelLabel: { en: () => 'Cancel', ko: () => '취소' },
  approveLabel: { en: () => '✅ Approve', ko: () => '✅ 승인' },
  // cap labels (channelCapBlocked용)
  capCoding: { en: () => 'coding', ko: () => '코딩' },
  capSchedule: { en: () => 'scheduling', ko: () => '예약' },
  capCollaborate: { en: () => 'collaboration', ko: () => '협업' },
  // status why-labels
  stuckLabel: { en: () => 'stuck (no progress)', ko: () => '막힘(진전 정체)' },
  budgetLabel: { en: () => 'budget exhausted', ko: () => '예산 소진' },
  stoppedLabel: { en: () => 'stopped', ko: () => '정지됨' },
  failureFallback: { en: () => 'failure', ko: () => '실패' },
  // reader / synthesizer / meeting
  noHitsHeader: { en: () => '⚠ No related content in the wiki — answering from general knowledge\n\n', ko: () => '⚠ 위키에 관련 내용 없음 — 일반 지식 기반 답변\n\n' },
  answerGenFailedBrainError: { en: () => 'Answer generation failed: brain call error', ko: () => '답변 생성 실패: 두뇌 호출 오류' },
  noContributions: { en: () => 'No expert input to synthesize.', ko: () => '전문가 기여가 없어 종합할 내용이 없습니다.' },
  synthesisFailed: { en: () => 'Synthesis failed: brain call error', ko: () => '종합 실패: 두뇌 호출 오류' },
  agendaHeader: { en: () => '# Agenda', ko: () => '# 안건' },
  conclusionHeader: { en: () => '# Conclusion', ko: () => '# 결론' },

  // ── with args ──
  chooseFromRange: { en: (n) => `Please pick a number from 1 to ${n}.`, ko: (n) => `1~${n} 중에서 골라주세요.` },
  teamFormed: { en: (team) => `Team: ${team} — looking into it`, ko: (team) => `팀 구성: ${team} — 알아볼게요` },
  teamFormedRetry: { en: (team, attempt) => `Team: ${team} — let's try again (retry ${attempt}/2)`, ko: (team, attempt) => `팀 구성: ${team} — 다시 해볼게요 (재시도 ${attempt}/2)` },
  channelCapBlocked: { en: (cap) => `This channel doesn't allow ${cap} (channel setting).`, ko: (cap) => `이 채널에선 ${cap}을 쓸 수 없어요(채널 설정).` },
  repoNotFound: { en: (ref) => `Couldn't find the repo '${ref}'. Use an alias from coderepos.json or the exact path.`, ko: (ref) => `'${ref}' 레포를 못 찾았어요. coderepos.json의 alias나 정확한 경로로 불러주세요.` },
  multipleReposFound: { en: (list) => `Found several:\n${list}\n@Engram <number> to pick one.`, ko: (list) => `여러 개 찾았어요:\n${list}\n@Engram <번호>로 골라주세요.` },
  proposalReady: { en: (targetPath, crit, test, build, typecheck) => `📁 Target: ${targetPath}\n📋 Acceptance criteria:\n${crit}\nGate: test=${test}|build=${build}|typecheck=${typecheck}\nLooks right? @Engram approve / to cancel @Engram cancel`, ko: (targetPath, crit, test, build, typecheck) => `📁 대상: ${targetPath}\n📋 완성조건:\n${crit}\n게이트: test=${test}|build=${build}|typecheck=${typecheck}\n맞으면 @Engram 승인 / 취소는 @Engram 취소` },
  codingTaskLabel: { en: (p) => `Coding: ${p}`, ko: (p) => `코딩: ${p}` },
  resumeGaveUp: { en: (sid) => `⚠️ Still not finished after two resumes — a human needs to take a look 🙏 (session ${sid})`, ko: (sid) => `⚠️ 두 번 재개해도 못 끝냈어요 — 사람이 봐야 해요 🙏 (세션 ${sid})` },
  resumeScheduled: { en: (why, human, id, attempt) => `⏸ ${why} — auto-resume scheduled for ${human} (#${id}, resume ${attempt + 1}/2). To stop: @Engram schedule cancel ${id}`, ko: (why, human, id, attempt) => `⏸ ${why} — ${human} 자동 재개 예약했어요 (#${id}, 재개 ${attempt + 1}/2). 멈추려면 @Engram 예약취소 ${id}` },
  resuming: { en: (p, attempt) => `▶ Continuing: ${p} (resume ${attempt}/2)`, ko: (p, attempt) => `▶ 이어서 할게요: ${p} (재개 ${attempt}/2)` },
  collabRetryScheduled: { en: (human, id, attempt) => `⏸ Something went wrong — retry scheduled for ${human} (#${id}, retry ${attempt + 1}/2). To stop: @Engram schedule cancel ${id}`, ko: (human, id, attempt) => `⏸ 작업 중 문제가 생겼어요 — ${human} 다시 해볼게요 (#${id}, 재시도 ${attempt + 1}/2). 멈추려면 @Engram 예약취소 ${id}` },
  codingSuccessMessage: { en: (p) => `✅ Coding complete: ${p} (landed on an isolated branch — awaiting human merge)`, ko: (p) => `✅ 코딩 완료: ${p} (격리 브랜치에 착지 — 사람 머지 대기)` },
  codingEndedMessage: { en: (why, sid) => `⚠️ Coding ended: ${why} (session ${sid})`, ko: (why, sid) => `⚠️ 코딩 종료: ${why} (세션 ${sid})` },
  scheduleCreated: { en: (id, cron, once) => `Okay, scheduled 📅 (schedule #${id}, ${cron})${onceEn(once)}`, ko: (id, cron, once) => `네, 예약했어요 📅 (예약 #${id}, ${cron})${onceKo(once)}` },
  scheduleListItem: { en: (i, id, cron, task, once) => `${i + 1}. [#${id}] ${cron} — "${task}"${once ? ' (once)' : ''}`, ko: (i, id, cron, task, once) => `${i + 1}. [#${id}] ${cron} — "${task}"${once ? ' (1회)' : ''}` },
  taskLine: { en: (q, team, failed) => `  - "${q}" (team: ${team})${failed ? ' (failed)' : ''}`, ko: (q, team, failed) => `  - "${q}" (팀: ${team})${failed ? ' (실패)' : ''}` },
  runningCount: { en: (n, list) => `In progress (${n}):\n${list}`, ko: (n, list) => `진행 중 ${n}건:\n${list}` },
  recentlyDone: { en: (list) => `Recently completed:\n${list}`, ko: (list) => `최근 완료:\n${list}` },
  teamFormedCollab: { en: (ps) => `🧑‍🤝‍🧑 Team: ${ps} — everyone starts researching`, ko: (ps) => `🧑‍🤝‍🧑 팀 구성: ${ps} — 각자 조사 시작합니다` },
  opinionArrived: { en: (p) => `✔ ${p}'s input is in`, ko: (p) => `✔ ${p} 의견 도착` },
  personaSkipped: { en: (p) => `⚠ ${p} skipped (error)`, ko: (p) => `⚠ ${p} 스킵(오류)` },
  decomposeDone: { en: (n) => `Breakdown complete — ${n} task(s)`, ko: (n) => `분해 완료 — 작업 ${n}개` },
  roundProgress: { en: (round, n) => `Round ${round + 1}: ${n} task(s) in progress`, ko: (round, n) => `라운드 ${round + 1}: 작업 ${n}개 진행` },
  codingTicket: { en: (a) => `  Coding: ${a}`, ko: (a) => `  코딩 중: ${a}` },
  gateRunning: { en: (a) => `  Running gate: ${a}`, ko: (a) => `  게이트 실행 중: ${a}` },
  ticketLanded: { en: (a) => `  ✓ Landed: ${a}`, ko: (a) => `  ✓ 착지: ${a}` },
  gateFailed: { en: (a, failed) => `  ✗ Gate red (waiting to retry): ${a} [${failed}]`, ko: (a, failed) => `  ✗ 게이트 빨강(재시도 대기): ${a} [${failed}]` },
  reviewerExtraTickets: { en: (n) => `Reviewer added ${n} more task(s)`, ko: (n) => `리뷰어 추가 작업 ${n}개` },
  meetingMinutesTitle: { en: (name, date) => `${name} meeting minutes (${date})`, ko: (name, date) => `${name} 회의록 (${date})` },
  sourcesFooter: { en: (list) => `\n\n───\nSources: ${list}`, ko: (list) => `\n\n───\n출처: ${list}` },
  answerGenFailedWithError: { en: (err) => `Answer generation failed: ${err}`, ko: (err) => `답변 생성 실패: ${err}` },
  yesterdayChannelInsight: { en: (r) => `☀️ Yesterday in this channel: ${r}`, ko: (r) => `☀️ 어제 이 채널: ${r}` },
  wikiPendingApproval: { en: (n) => `📋 ${n} wiki item(s) awaiting approval — approve them with \`engram review\` in the terminal`, ko: (n) => `📋 위키 결재 대기 ${n}건 — 터미널에서 engram review로 승인해줘` },
  supersededMarker: { en: (id, sources, payload) => `\n\n<!-- superseded by proposal ${id} (sources: ${sources}) -->\n${payload}`, ko: (id, sources, payload) => `\n\n<!-- superseded by 제안 ${id} (출처: ${sources}) -->\n${payload}` },
  // resume-policy human labels
  humanToday: { en: (hour) => `today at ${hour}:00`, ko: (hour) => `오늘 ${hour}시` },
  humanTomorrow: { en: (hour) => `tomorrow at ${hour}:00`, ko: (hour) => `내일 ${hour}시` },
  humanMinutesLater: { en: (min, hhmm) => `in ${min} min (${hhmm})`, ko: (min, hhmm) => `${min}분 뒤(${hhmm})` },
};

export function t(key: string, ...args: any[]): string {
  const entry = MESSAGES[key];
  if (!entry) throw new Error(`i18n: unknown key '${key}'`);
  const lang = configuredLang();
  const fn = (entry as any)[lang] ?? entry.en; // 미지원 언어 → en 폴백
  return fn(...args);
}
```

- [ ] **Step 4: 통과 확인** — `npx jest src/agent-layer/i18n.spec.ts` → PASS

- [ ] **Step 5: 커밋**
```
git add src/agent-layer/i18n.ts src/agent-layer/i18n.spec.ts
git commit -m "feat(i18n): 백엔드 T 사전 t(key,...args) en/ko(configuredLang 추종)"
```

---

## Task 2: orchestrator.ts 사용자 대면 문자열 → `t()`

**Files:**
- Modify: `src/agent-layer/orchestrator.ts`
- Test: `src/agent-layer/orchestrator.spec.ts` (기존 한국어 단언 → 영어/기본 en로 갱신)

**Interfaces:** Consumes `t` from `./i18n`. `import { t } from './i18n';`

**규칙(재확인):** `post(...)`/`prog(...)`/`report(...)`/사용자 반환 문자열의 한국어를 `t('key', ...args)`로 교체. **Action `send` 값은 그대로**(label만 `t()`). 입력 매처(`=== '승인'` 등)·`logger.*`·`throw`는 안 건드림.

교체 매핑(카탈로그 기준, 문자열로 위치 찾기 — 라인은 이동 가능):

| 현재 한국어 문자열(위치 단서) | → 교체 |
|---|---|
| `post('취소했어요.')` (2곳) | `post(t('cancelled'))` |
| `` `1~${p.candidates.length} 중에서 골라주세요.` `` | `t('chooseFromRange', p.candidates.length)` |
| `'예약 기능이 준비되지 않았어요.'` (3곳) | `t('scheduleNotReady')` |
| `'그 예약을 못 찾았어요.'` | `t('scheduleNotFound')` |
| `` `팀 구성: ${team.join('·')} — 다시 해볼게요 (재시도 ${attempt}/2)` `` | `t('teamFormedRetry', team.join('·'), attempt)` |
| `` `팀 구성: ${team.join('·')} — 알아볼게요` `` (2곳) | `t('teamFormed', team.join('·'))` |
| `'이 채널엔 아직 작업 폴더가 없어요…📁'` | `t('noRepoFolder')` |
| Action `label: '구현 시작'`(send는 `'구현 시작'` 유지) | `label: t('startImplementationLabel')` |
| `'작업 중 문제가 생겼어요 — 사람이 봐야 해요 🙏'` | `t('collabFailedNeedHuman')` |
| `'작업 중 문제가 생겼어요 🙏'` | `t('collabFailed')` |
| 상태 라벨 맵 `{ coding:'코딩', schedule:'예약', collaborate:'협업' }` | `{ coding: t('capCoding'), schedule: t('capSchedule'), collaborate: t('capCollaborate') }` |
| `` `이 채널에선 ${label[cap]}을 쓸 수 없어요(채널 설정).` `` | `t('channelCapBlocked', label[cap])` |
| `` `'${repoRef}' 레포를 못 찾았어요…` `` | `t('repoNotFound', repoRef)` |
| Action `label: '취소'`(send `'취소'` 유지, 여러 곳) | `label: t('cancelLabel')` |
| `` `여러 개 찾았어요:\n${…}\n@Engram <번호>로 골라주세요.` `` | `t('multipleReposFound', matches.map((m,i)=>`${i+1}. ${m}`).join('\n'))` |
| `'지금 답하기 어려웠어요 🙏'` (2곳) | `t('answerUnavailable')` |
| `'코딩 기능이 준비되지 않았어요.'` (2곳) | `t('codingNotReady')` |
| `'그 경로엔 쓸 수 없어요(보호 경로).'` | `t('pathProtected')` |
| 완성조건 게시 `` `📁 대상: …\n…맞으면 @Engram 승인 / 취소는 @Engram 취소` `` | `t('proposalReady', targetPath, crit, cfg.gate.test, cfg.gate.build, cfg.gate.typecheck)` |
| Action `label: '✅ 승인'`(send `'승인'` 유지) | `label: t('approveLabel')` |
| `confirm: '자율 코딩을 시작할까요?'` | `confirm: t('startCodingConfirm')` |
| tracker `` `코딩: ${targetPath}` `` | `t('codingTaskLabel', targetPath)` |
| `'자율 코딩 시작할게요. 진행은 여기 올릴게요.'` | `t('codingStarted')` |
| `` `⚠️ 두 번 재개해도 못 끝냈어요 …(세션 ${r.sessionId})` `` | `t('resumeGaveUp', r.sessionId)` |
| `'코딩 중 문제가 생겼어요 🙏'` | `t('codingFailed')` |
| `status === 'STUCK' ? '막힘(진전 정체)' : '예산 소진'` | `status === 'STUCK' ? t('stuckLabel') : t('budgetLabel')` |
| `` `⏸ ${why} — ${human} 자동 재개 예약했어요 …멈추려면 @Engram 예약취소 ${e.id}` `` | `t('resumeScheduled', why, human, e.id, attempt)` |
| `'그 프로젝트를 못 찾았어요.'` | `t('projectNotFound')` |
| `'승인되지 않은 프로젝트예요.'` | `t('projectNotApproved')` |
| `` `▶ 이어서 할게요: ${project.targetPath} (재개 ${attempt}/2)` `` | `t('resuming', project.targetPath, attempt)` |
| `` `⏸ 작업 중 문제가 생겼어요 — ${human} 다시 해볼게요 …@Engram 예약취소 ${e.id}` `` | `t('collabRetryScheduled', human, e.id, attempt)` |
| `` `✅ 코딩 완료: ${targetPath} (격리 브랜치에 착지 — 사람 머지 대기)` `` | `t('codingSuccessMessage', targetPath)` |
| why 맵 `{ STUCK:'막힘(진전 정체)', STOPPED:'정지됨', BUDGET:'예산 소진' }` | `{ STUCK: t('stuckLabel'), STOPPED: t('stoppedLabel'), BUDGET: t('budgetLabel') }` |
| `` `⚠️ 코딩 종료: ${why[r.status] ?? r.status} (세션 ${r.sessionId})` `` | `t('codingEndedMessage', why[r.status] ?? r.status, r.sessionId)` |
| `` `네, 예약했어요 📅 (예약 #${e.id}, ${e.cron})${once ? ' — 1회' : ''}` `` | `t('scheduleCreated', e.id, e.cron, once)` |
| `'언제인지 잘 모르겠어요…'` | `t('scheduleUnclear')` |
| `'예약이 없어요.'` | `t('noSchedules')` |
| `` `${i + 1}. [#${e.id}] ${e.cron} — "${e.task.slice(0,40)}"${e.once ? ' (1회)' : ''}` `` | `t('scheduleListItem', i, e.id, e.cron, e.task.slice(0,40), e.once)` |
| `'지금 진행 중이거나 최근 완료한 작업이 없어요.'` | `t('noTasks')` |
| `` `  - "${t.question.slice(0,40)}" (팀: ${…})${… ' (실패)' …}` `` (line 헬퍼) | `t('taskLine', t.question.slice(0,40), t.team.join('·') || '-', t.state === 'failed')` |
| `` `진행 중 ${running.length}건:\n${…}` `` | `t('runningCount', running.length, running.map(line).join('\n'))` |
| `` `최근 완료:\n${…}` `` | `t('recentlyDone', finished.map(line).join('\n'))` |
| `` `🧑‍🤝‍🧑 팀 구성: ${personas.join(', ')} — 각자 조사 시작합니다` `` | `t('teamFormedCollab', personas.join(', '))` |
| `` `✔ ${p} 의견 도착` `` | `t('opinionArrived', p)` |
| `` `⚠ ${p} 스킵(오류)` `` | `t('personaSkipped', p)` |
| `'📝 의견 종합 중…'` | `t('synthesizingOpinions')` |
| `'작업 분해 중… (두뇌 호출)'` | `t('decomposing')` |
| `` `분해 완료 — 작업 ${initial.length}개` `` | `t('decomposeDone', initial.length)` |
| `` `라운드 ${round + 1}: 작업 ${open.length}개 진행` `` | `t('roundProgress', round, open.length)` |
| `` `  코딩 중: ${ticket.area}` `` | `t('codingTicket', ticket.area)` |
| `` `  게이트 실행 중: ${ticket.area}` `` | `t('gateRunning', ticket.area)` |
| `` `  ✓ 착지: ${ticket.area}` `` | `t('ticketLanded', ticket.area)` |
| `` `  ✗ 게이트 빨강(재시도 대기): ${ticket.area} [${result.failed ?? '실패'}]` `` | `t('gateFailed', ticket.area, result.failed ?? t('failureFallback'))` |
| `'완성조건 리뷰 중…'` | `t('reviewingCriteria')` |
| `'✓ 완성조건 충족 — 완료'` | `t('criteriaMet')` |
| `` `리뷰어 추가 작업 ${review.extraTickets.length}개` `` | `t('reviewerExtraTickets', review.extraTickets.length)` |
| `'완성조건 충족 — 사람 머지 대기'` (setResult) | `t('criteriaMetStored')` |

- [ ] **Step 1: 실패 테스트/기존 갱신** — 먼저 기존 `orchestrator.spec.ts`를 `npx jest src/agent-layer/orchestrator.spec.ts`로 돌려 한국어 단언 목록 파악. 대표 흐름 하나에 대해 기본(en) 출력 단언을 추가:
```ts
it('cancel posts English by default (ENGRAM_LANG unset)', async () => {
  // (기존 pending 취소 흐름 목 구성 재사용) 취소 입력 → post 캡처
  // expect(posted).toContain('Cancelled.');
});
```
(구현자가 기존 spec의 목 패턴을 재사용해 최소 1개 흐름을 en으로 단언. 나머지 한국어 단언은 Step 3에서 영어로 갱신.)

- [ ] **Step 2: 실패 확인** — 갱신 전이라 신규 en 단언 FAIL

- [ ] **Step 3: 구현 + 기존 테스트 갱신** — 위 매핑 전부 적용. `import { t } from './i18n';` 추가. 기존 spec의 한국어 단언을 대응 영어 문자열(기본 en)로 바꾸거나 그 테스트에 `process.env.ENGRAM_LANG='ko'`(+afterEach 정리) 설정. **Action `send` 리터럴은 절대 안 바꿈** — 관련 테스트가 send를 단언하면 그대로 통과해야 함.

- [ ] **Step 4: 통과 확인** — `npx jest src/agent-layer/orchestrator.spec.ts` → PASS

- [ ] **Step 5: 커밋**
```
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator.spec.ts
git commit -m "feat(i18n): orchestrator 사용자 대면 문자열 → t()(send 토큰·매처 불변)"
```

---

## Task 3: reader-agent · synthesizer · meeting-engine · resume-policy → `t()`

**Files:**
- Modify: `src/agent-layer/reader-agent.ts`, `src/agent-layer/synthesizer.ts`, `src/agent-layer/meeting-engine.ts`, `src/agent-layer/resume-policy.ts`
- Test: 각 `*.spec.ts` 갱신/추가

**Interfaces:** `import { t } from './i18n';`

교체:
- reader-agent: `NO_HITS_HEADER` 상수 사용처 → `t('noHitsHeader')`(상수 제거 또는 `const NO_HITS_HEADER = ...` 대신 호출부에서 `t`). `'답변 생성 실패: 두뇌 호출 오류'` → `t('answerGenFailedBrainError')`. sources footer `` `\n\n───\n출처: ${…}` `` → `t('sourcesFooter', hits.map((h,i)=>`[${i+1}] ${h.title} (${h.slug})`).join(' · '))`. `` `답변 생성 실패: ${String(err)}` `` → `t('answerGenFailedWithError', String(err))`.
  - (주의: `NO_HITS_HEADER`가 `header` 계산·emit·return에 여러 번 쓰인다. `const header = hits.length === 0 ? t('noHitsHeader') : '';`로 한 번 계산해 재사용.)
- synthesizer: `'전문가 기여가 없어 종합할 내용이 없습니다.'` → `t('noContributions')`. `'종합 실패: 두뇌 호출 오류'` → `t('synthesisFailed')`.
- meeting-engine: title `` `${def.name} 회의록 (${date})` `` → `t('meetingMinutesTitle', def.name, date)`. body `` `# 안건\n${def.agenda}\n\n# 결론\n${summary}` `` → `` `${t('agendaHeader')}\n${def.agenda}\n\n${t('conclusionHeader')}\n${summary}` ``.
- resume-policy: `human` 조립부(`'오늘'/'내일'` + `시`, `분 뒤(HH:MM)`)를 `t('humanToday', hour)`/`t('humanTomorrow', hour)`/`t('humanMinutesLater', min, `${HH}:${MM}`)`로. (정확한 현재 코드를 읽어 조건 분기에 맞춰 교체.)

- [ ] **Step 1: 실패 테스트** — 각 파일 대표 단언(기본 en):
```ts
// synthesizer: 빈 blackboard → t('noContributions')
it('synthesizer empty → English', async () => {
  const s = new Synthesizer({ complete: async () => ({ text: '' }) } as any);
  expect(await s.synthesize('q', {})).toBe('No expert input to synthesize.');
});
// meeting-engine: 회의록 body에 '# Agenda'/'# Conclusion' 포함(기존 목 흐름 재사용)
// reader-agent: hits 0 → 반환에 'No related content in the wiki' 포함(기존 spec 갱신)
```
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현 + 기존 한국어 단언 영어로 갱신**
- [ ] **Step 4: 통과 확인** — `npx jest src/agent-layer/reader-agent.spec.ts src/agent-layer/synthesizer.spec.ts src/agent-layer/meeting-engine.spec.ts src/agent-layer/resume-policy.spec.ts` → PASS
- [ ] **Step 5: 커밋**
```
git add src/agent-layer/reader-agent.ts src/agent-layer/synthesizer.ts src/agent-layer/meeting-engine.ts src/agent-layer/resume-policy.ts src/agent-layer/*.spec.ts
git commit -m "feat(i18n): reader·synthesizer·meeting·resume-policy 사용자 문자열 → t()"
```

---

## Task 4: ambient-service · proposal-applier (edge) → `t()`

**Files:**
- Modify: `src/edge/ambient-service.ts`, `src/edge/proposal-applier.ts`
- Test: 각 `*.spec.ts` 갱신/추가

**Interfaces:** `import { t } from '../agent-layer/i18n';`

교체:
- ambient-service: `` `☀️ 어제 이 채널: ${ins.report}` `` → `t('yesterdayChannelInsight', ins.report)`. `` `📋 위키 결재 대기 ${pending.length}건 — 터미널에서 engram review로 승인해줘` `` → `t('wikiPendingApproval', pending.length)`.
- proposal-applier: supersede 마커 `` `\n\n<!-- superseded by 제안 ${p.id} (출처: ${p.sources.join(', ')}) -->\n${p.payload}` `` → `t('supersededMarker', p.id, p.sources.join(', '), p.payload)`.

- [ ] **Step 1: 실패 테스트**(기본 en) — 예: proposal-applier supersede 결과 본문에 `superseded by proposal` 포함; ambient 게시에 `Yesterday in this channel` 포함(기존 목 재사용).
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현 + 기존 한국어 단언 갱신**
- [ ] **Step 4: 통과 확인** — 해당 spec + **전체 회귀** `npx jest` + `npx tsc --noEmit` → 새 실패 0.
- [ ] **Step 5: 커밋**
```
git add src/edge/ambient-service.ts src/edge/proposal-applier.ts src/edge/*.spec.ts
git commit -m "feat(i18n): ambient-service·proposal-applier 사용자 문자열 → t()"
```

---

## Self-Review (작성자 체크)

- **스펙 D 커버리지**: 카탈로그 80개(orchestrator 66·reader 4·synthesizer 2·meeting 3·ambient 2·proposal 1·resume-policy 2) 전부 Task 1 사전 + Task 2~4 교체로 매핑됨.
- **Placeholder**: 사전 en/ko 전부 명시, 교체는 매핑표로 지정.
- **타입 일관성**: `t(key, ...args)` 시그니처가 사전 각 키의 인자 수와 호출부 매핑 인자 수 일치(예: `teamFormedRetry(team, attempt)`↔`t('teamFormedRetry', team, attempt)`).
- **범위/리스크**: Action `send` 불변·입력 매처 불변·로그/throw/CLI 제외를 Global Constraints·Task 2 규칙에 명시. 기본 언어 en 전환에 따른 기존 테스트 갱신을 각 태스크에 명시.
- **비범위 명시**: `src/edge/cli.gateway.ts`(터미널 CLI, ~25 문자열)는 별도 표면 — 이 플랜 밖. 원하면 후속 소플랜.
