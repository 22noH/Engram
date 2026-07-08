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
  mentionHandleFailed: { en: () => "Can't handle that right now 🙏", ko: () => '지금 처리가 안 되네요 🙏' },
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
