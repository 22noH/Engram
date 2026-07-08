// 자가 재개 예약 시각 계산(6b-3-2). 순수 — now 주입, env는 호출 시점 해석(로컬 타임존).
import { t } from './i18n';

export type ResumeKind = 'STUCK' | 'BUDGET' | 'COLLAB';

// 비숫자/범위밖 env는 기본값 폴백(Number.isFinite 가드 — Phase 1 백로그① 패턴).
function envMinutes(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

function envHour(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.floor(n) : def;
}

function two(n: number): string { return String(n).padStart(2, '0'); }

// once용 5필드 cron('분 시 일 월 *')과 사람용 설명.
// STUCK=60분 뒤(ENGRAM_RESUME_STUCK_MIN) · COLLAB=30분 뒤(ENGRAM_RESUME_COLLAB_MIN) ·
// BUDGET=다음 9시(ENGRAM_RESUME_BUDGET_HOUR, 지났으면 내일).
export function computeResume(kind: ResumeKind, now: Date): { cron: string; human: string } {
  let at: Date;
  let human: string;
  if (kind === 'BUDGET') {
    const hour = envHour('ENGRAM_RESUME_BUDGET_HOUR', 9);
    at = new Date(now);
    at.setHours(hour, 0, 0, 0);
    if (at <= now) at.setDate(at.getDate() + 1);
    human = at.toDateString() === now.toDateString() ? t('humanToday', hour) : t('humanTomorrow', hour);
  } else {
    const min = envMinutes(
      kind === 'STUCK' ? 'ENGRAM_RESUME_STUCK_MIN' : 'ENGRAM_RESUME_COLLAB_MIN',
      kind === 'STUCK' ? 60 : 30,
    );
    at = new Date(now.getTime() + min * 60_000);
    human = t('humanMinutesLater', min, `${two(at.getHours())}:${two(at.getMinutes())}`);
  }
  return { cron: `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`, human };
}
