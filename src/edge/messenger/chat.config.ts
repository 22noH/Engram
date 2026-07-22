import * as fs from 'fs';
import * as path from 'path';
import type { RetentionPolicy } from './chat-store';

// 자체 채팅 서버 설정(스펙 §3). 기본 = 가동·127.0.0.1:47800. enabled:false만 끔.
// env는 포트/바인딩 오버라이드. 인증은 계정(Phase 16a) — 공유 토큰은 폐기.

export const DEFAULT_CHAT_PORT = 47800;

export interface ChatConfig {
  enabled: boolean;
  port: number;
  bind: string;
  language?: string; // BCP-47 코드(예 'ko'/'en'). 미설정=OS 로케일 폴백(main.ts).
  role: 'server' | 'brain'; // brain=계정·team·위키승인 미탑재, 127.0.0.1 고정(Phase 16a 스펙 §2.1).
  retention?: RetentionPolicy; // Task 2(S4): 대화 자동 보존 정책. 미설정=ChatStore 기본(unlimited) — 회귀 0.
  // Task 5(clear-compact): 보존 프루닝 직전 자동 요약→위키 게시 토글. 기본 true — undefined도 true로
  // 취급(호출부 책임, `chatCfg.autoCompact === false`로만 끈다). 명시적 false만 끔.
  autoCompact?: boolean;
}

function validPort(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null; // NaN·0·음수·소수·65535 초과 → 무시(기존 env 가드 관례)
}

// retention 값 검증(chat-store.ts의 setRetention 판정과 동일한 결 — count=양의 정수·days=양수).
// 여기 별도 구현하는 이유: chat-store.ts의 isPositiveInt/isPositiveNumber는 비공개(모듈 경계 최소화,
// 이 파일이 필요한 건 "저장해도 안전한 값인가" 판정뿐이라 굳이 export로 결합을 늘리지 않는다).
function isValidRetention(v: unknown): v is RetentionPolicy {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.mode === 'unlimited') return true;
  if (r.mode === 'count') return typeof r.value === 'number' && Number.isFinite(r.value) && Number.isInteger(r.value) && r.value > 0;
  if (r.mode === 'days') return typeof r.value === 'number' && Number.isFinite(r.value) && r.value > 0;
  return false;
}

export function loadChatConfig(configDir: string, env: NodeJS.ProcessEnv = process.env): ChatConfig {
  let raw: Partial<ChatConfig> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'chat.json'), 'utf8')) as unknown;
    // JSON.parse는 'null'/'123' 같은 비객체도 유효 JSON으로 통과 — 객체만 수용(fault-tolerant).
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Partial<ChatConfig>;
  } catch {
    raw = {};
  }
  const port = (env.ENGRAM_CHAT_PORT ? validPort(env.ENGRAM_CHAT_PORT) : null)
    ?? validPort(raw.port)
    ?? DEFAULT_CHAT_PORT;
  const role: 'server' | 'brain' = (env.ENGRAM_CHAT_ROLE === 'brain' || raw.role === 'brain') ? 'brain' : 'server';
  const bind = role === 'brain' ? '127.0.0.1' : (
    (typeof env.ENGRAM_CHAT_BIND === 'string' && env.ENGRAM_CHAT_BIND)
    || (typeof raw.bind === 'string' && raw.bind)
    || '127.0.0.1'
  );
  const language = typeof raw.language === 'string' && raw.language.trim() ? raw.language.trim() : undefined;
  const retention = isValidRetention(raw.retention) ? raw.retention : undefined;
  const autoCompact = typeof raw.autoCompact === 'boolean' ? raw.autoCompact : undefined;
  return { enabled: raw.enabled !== false, port, bind, language, role, retention, autoCompact };
}

// 부팅 설정(port/bind) 저장(서버 콘솔 S3 Task 2 — admin-http server-settings api 전용).
// chat.json에 기존 필드(enabled/role/language 등)를 보존한 채 port/bind만 부분 갱신한다
// (permissions-file.ts의 read-merge-write 관례와 동일 결). env가 항상 파일보다 우선하므로
// (loadChatConfig) 여기 저장은 "재시작 시 적용"이지 즉시 반영이 아니다 — 콘솔 쪽 "재시작 후 적용"
// 힌트 문구와 짝을 이룬다. 무효값(범위 밖 port·빈 bind)은 조용히 무시(기존 값 보존).
export function saveChatBootConfig(
  configDir: string,
  patch: { port?: number; bind?: string; retention?: RetentionPolicy; autoCompact?: boolean },
): void {
  let raw: Partial<ChatConfig> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'chat.json'), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Partial<ChatConfig>;
  } catch { /* 없거나 깨짐 → 빈 값에서 시작(house rule: 값 있으면 항상 덮어쓰기 가능해야 함) */ }
  const next: Partial<ChatConfig> = { ...raw };
  if (patch.port !== undefined) {
    const p = validPort(patch.port);
    if (p !== null) next.port = p;
  }
  if (typeof patch.bind === 'string' && patch.bind.trim()) next.bind = patch.bind.trim();
  // retention: 호출부(admin-http.ts)가 이미 검증한 값을 넘기는 게 정상 경로지만, 방어적으로 여기서도
  // 한 번 더 걸러(port/bind와 같은 결) 무효값이 파일에 눌러앉지 않게 한다 — 무효면 기존 값 보존.
  if (patch.retention !== undefined && isValidRetention(patch.retention)) next.retention = patch.retention;
  // autoCompact: retention과 동일한 부분갱신 결(touched 게이트는 Task 6/7 콘솔 쪽 책임 — 여기선 boolean만 검증).
  if (typeof patch.autoCompact === 'boolean') next.autoCompact = patch.autoCompact;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'chat.json'), JSON.stringify(next, null, 2));
}
