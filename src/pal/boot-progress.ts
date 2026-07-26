import * as fs from 'fs';
import * as path from 'path';

// 부팅 단계 보고(실사고 2026-07-26: 네 번째 '무한 시작 중').
//
// 왜 필요한가: 상주 백엔드는 리슨(헬스 200)에 도달해야만 존재를 알린다. 그 전까지 껍데기(셸)가
// 아는 것은 "아직 연결이 안 된다"뿐이라, 정상 기동(모델 로드·색인)과 영영 안 끝나는 부팅이
// 화면에서 완전히 똑같이 보였다 — 사용자는 회색 "Engram 시작 중…"을 8시간 넘게 봤다.
//
// 왜 파일인가: 리슨 전에는 HTTP도 ws도 없어 정보를 실어 보낼 통로가 없다. stdout 파싱은 자식이
// 죽으면 같이 끊기고 로그 노이즈와 섞인다. 상태 파일은 이 레포가 이미 쓰는 관례(state/heartbeat,
// desktop/status.ts의 readStatus)와 같은 결이고, 프로세스가 멈춰도 마지막 단계가 디스크에 남아
// "어디서 멈췄는지"가 사후에도 읽힌다 — 이번 사고에서 가장 아쉬웠던 그 정보다.
export type BootStage = 'start' | 'wiki' | 'rag' | 'index' | 'wiring' | 'ready';

// 표시 순서 = 실제 부팅 순서. 'ready'는 도착점이라 단계 수(n/N)에서 제외한다.
export const BOOT_STAGE_ORDER: readonly BootStage[] = ['start', 'wiki', 'rag', 'index', 'wiring', 'ready'];
export const BOOT_STEPS = BOOT_STAGE_ORDER.length - 1;

export interface BootProgress {
  stage: BootStage;
  at: number; // 이 단계로 진입한 시각(epoch ms) — 정체 판정의 기준
  startedAt: number; // 백엔드 프로세스가 시작한 시각(경과 시간 표시·구세대 파일 판별)
  pid: number;
  done?: number; // 'index' 단계의 진행(색인 끝난 페이지 수)
  total?: number;
}

export function bootProgressPath(dataDir: string): string {
  return path.join(dataDir, 'state', 'boot-progress.json');
}

// 계측이 부팅을 막으면 본말전도 — 쓰기 실패는 전부 삼킨다(로그도 아직 못 믿는 시점).
export function writeBootProgress(dataDir: string, p: BootProgress): void {
  try {
    const file = bootProgressPath(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(p));
  } catch {
    /* best-effort */
  }
}

export function readBootProgress(dataDir: string): BootProgress | null {
  try {
    const raw = JSON.parse(fs.readFileSync(bootProgressPath(dataDir), 'utf8')) as Partial<BootProgress>;
    if (!raw || typeof raw.stage !== 'string' || !BOOT_STAGE_ORDER.includes(raw.stage as BootStage)) return null;
    if (typeof raw.at !== 'number' || typeof raw.startedAt !== 'number') return null;
    return {
      stage: raw.stage as BootStage,
      at: raw.at,
      startedAt: raw.startedAt,
      pid: typeof raw.pid === 'number' ? raw.pid : 0,
      done: typeof raw.done === 'number' ? raw.done : undefined,
      total: typeof raw.total === 'number' ? raw.total : undefined,
    };
  } catch {
    return null;
  }
}

// 백엔드가 단계를 남긴다. startedAt은 process.uptime()에서 역산 — 모듈 전역 상태를 두지 않아
// (KnowledgeCoreModule·main.ts 등) 호출자가 여럿이어도 같은 값이 나온다.
export function markBootStage(
  dataDir: string,
  stage: BootStage,
  extra?: { done?: number; total?: number },
  now: number = Date.now(),
): void {
  writeBootProgress(dataDir, {
    stage,
    at: now,
    startedAt: Math.round(now - process.uptime() * 1000),
    pid: process.pid,
    done: extra?.done,
    total: extra?.total,
  });
}

// ---- 표시(셸 스플래시) ----

export function bootStageStep(stage: BootStage): number {
  const i = BOOT_STAGE_ORDER.indexOf(stage);
  return i < 0 ? 1 : Math.min(i + 1, BOOT_STEPS);
}

export function bootStageLabel(stage: BootStage, ko: boolean): string {
  switch (stage) {
    case 'wiki':
      return ko ? '위키 저장소 준비 중' : 'Preparing wiki storage';
    case 'rag':
      return ko ? '검색 색인 여는 중' : 'Opening search index';
    case 'index':
      return ko ? '위키 페이지 색인 중' : 'Indexing wiki pages';
    case 'wiring':
      return ko ? '서비스 시작 중' : 'Starting services';
    case 'ready':
      return ko ? '거의 다 됐어요' : 'Almost there';
    default:
      return ko ? '두뇌 켜는 중' : 'Waking the brain';
  }
}

export function formatElapsed(ms: number, ko: boolean): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m === 0) return ko ? `${rest}초` : `${rest}s`;
  return ko ? `${m}분 ${rest}초` : `${m}m ${rest}s`;
}

// 이전 실행이 남긴 파일을 이번 부팅의 진행으로 오독하지 않게 — 이번 자식이 시작한 시각보다
// 뚜렷하게 앞선 기록은 버린다(자식 fork와 프로세스 시작 사이의 오차만큼 여유를 둔다).
const STALE_SLACK_MS = 10_000;
export function isFreshBootProgress(p: BootProgress | null, childStartedAt: number): p is BootProgress {
  return p !== null && p.startedAt >= childStartedAt - STALE_SLACK_MS;
}

// 스플래시 한 줄: "위키 페이지 색인 중 (4/5) · 1분 20초". 아직 아무 단계도 못 받았으면
// (구버전 백엔드·초기 순간) 단계 없이 경과 시간만 — 최소한 "살아 있다"는 보인다.
export function bootSplashText(
  p: BootProgress | null,
  childStartedAt: number,
  now: number,
  ko: boolean,
): string {
  const fresh = isFreshBootProgress(p, childStartedAt) ? p : null;
  const elapsed = formatElapsed(now - (fresh?.startedAt ?? childStartedAt), ko);
  if (!fresh) return `${ko ? 'Engram 시작 중…' : 'Starting Engram…'} · ${elapsed}`;
  const step = `(${bootStageStep(fresh.stage)}/${BOOT_STEPS})`;
  const count =
    fresh.stage === 'index' && typeof fresh.total === 'number' && fresh.total > 0
      ? ` ${fresh.done ?? 0}/${fresh.total}`
      : '';
  return `${bootStageLabel(fresh.stage, ko)}${count} ${step} · ${elapsed}`;
}

// 정체 판정: 마지막 단계 변화(단계를 하나도 못 받았으면 자식 시작 시각) 이후 limitMs가 지나면
// 정체로 본다. 첫 부팅 모델 내려받기(수 분)를 오판하지 않게 임계는 넉넉히 잡고, 판정이 서도
// 폴링은 계속한다 — 이 판정은 "포기"가 아니라 "화면을 안내로 바꾼다"는 뜻일 뿐이다.
export function isBootStalled(
  p: BootProgress | null,
  childStartedAt: number,
  now: number,
  limitMs: number,
): boolean {
  const last = isFreshBootProgress(p, childStartedAt) ? p.at : childStartedAt;
  return now - last >= limitMs;
}
