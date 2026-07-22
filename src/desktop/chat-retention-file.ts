import type { RetentionPolicy } from '../edge/messenger/chat-store';
import { loadChatConfig, saveChatBootConfig } from '../edge/messenger/chat.config';

// 데스크톱 개인앱 설정창(clear-compact Task 7) — 대화 보존 + 자동 정리(auto-compact) 조회/저장.
// 개인앱은 로그인이 없어 이 설정은 admin-http API가 아니라 로컬 config(chat.json)를 직접
// 읽고/쓴다. 로직 자체는 이미 테스트된 chat.config.ts(loadChatConfig/saveChatBootConfig)에
// 위임(main.ts 관례: "로직은 테스트된 모듈에 위임") — 이 파일은 IPC 경계에서 오는 값을 한 번 더
// 방어적으로 검증하는 얇은 어댑터다(saveChatBootConfig도 내부에서 이미 무효 retention을 거르지만,
// 여기서 먼저 걸러 "set 호출 자체가 무엇을 왜 무시했는지"가 이 모듈 하나로 드러나게 한다 —
// chat.config.ts 자신의 isValidRetention 주석과 같은 이유로 여기서도 재구현해 모듈 결합을 늘리지 않는다).

export function getChatRetention(configDir: string): { retention: RetentionPolicy; autoCompact: boolean } {
  const cfg = loadChatConfig(configDir);
  return {
    retention: cfg.retention ?? { mode: 'unlimited' },
    autoCompact: cfg.autoCompact ?? true,
  };
}

function isValidRetention(v: unknown): v is RetentionPolicy {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.mode === 'unlimited') return true;
  if (r.mode === 'count') return typeof r.value === 'number' && Number.isFinite(r.value) && Number.isInteger(r.value) && r.value > 0;
  if (r.mode === 'days') return typeof r.value === 'number' && Number.isFinite(r.value) && r.value > 0;
  return false;
}

// 무효 retention(예: 잘못된 mode·음수 value)은 조용히 무시(그 필드만 생략) — 기존 값 보존.
// autoCompact도 boolean이 아니면 생략(saveChatBootConfig와 동일한 결).
export function setChatRetention(configDir: string, retention: unknown, autoCompact: unknown): void {
  const patch: { retention?: RetentionPolicy; autoCompact?: boolean } = {};
  if (isValidRetention(retention)) patch.retention = retention;
  if (typeof autoCompact === 'boolean') patch.autoCompact = autoCompact;
  saveChatBootConfig(configDir, patch);
}
