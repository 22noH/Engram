import type { BrowserLogEntry } from '../../../shared/browser-ops';

// AI 웹 조작의 화면 상태(행동 로그 + 확인 대기 + 콘솔 링버퍼).
//
// 왜 모듈 전역인가: 조작을 실행하는 쪽(App의 ws 프레임 처리)과 보여주는 쪽(BrowserPane의 확인 줄·
// 로그)이 서로 다른 컴포넌트다. views.ts(살아있는 webview 장부)와 같은 결로 장부 하나를 둔다 —
// props를 위아래로 나르는 것보다 단순하고, 구독 해제 지점이 한 곳뿐이라 새지 않는다.

export interface PendingConfirm {
  id: string;
  channelId: string;
  /** 확인 줄에 보여줄 문구(예: "로그인 버튼을 클릭합니다"). */
  label: string;
  /** 어느 주소에서 벌어지는 일인지(외부 사이트임을 사용자가 알아야 한다). */
  url: string;
  decide: (allow: boolean) => void;
}

const MAX_LOG = 40;
const MAX_CONSOLE = 200;

const logs = new Map<string, BrowserLogEntry[]>();
const consoles = new Map<string, string[]>();
let pending: PendingConfirm | null = null;
const listeners = new Set<() => void>();
let seq = 0;

function emit(): void {
  for (const l of [...listeners]) {
    try { l(); } catch { /* 구독자 하나가 죽어도 나머지는 살린다 */ }
  }
}

export function subscribeAgent(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ---- 행동 로그(채널별) ----

export function agentLog(channelId: string): BrowserLogEntry[] {
  return logs.get(channelId) ?? [];
}

export function appendAgentLog(channelId: string, entry: Omit<BrowserLogEntry, 'id' | 'ts'>): BrowserLogEntry {
  seq += 1;
  const full: BrowserLogEntry = { id: `log-${seq}`, ts: Date.now(), ...entry };
  const next = [...agentLog(channelId), full].slice(-MAX_LOG);
  logs.set(channelId, next);
  emit();
  return full;
}

export function clearAgentLog(channelId: string): void {
  logs.delete(channelId);
  emit();
}

// ---- 확인 대기(한 번에 하나) ----
// 두뇌는 조작을 순차로 부르므로 동시에 두 개가 뜰 일이 없다. 그래도 겹치면 나중 것이 앞의 것을
// 자동으로 "건너뛰기" 처리한다 — 화면에 카드가 쌓여 사용자가 무엇에 답하는지 모르게 되는 쪽이 더 나쁘다.

export function agentPending(): PendingConfirm | null {
  return pending;
}

export function requestConfirm(channelId: string, label: string, url: string): Promise<boolean> {
  if (pending) {
    const stale = pending;
    pending = null;
    stale.decide(false);
  }
  return new Promise<boolean>((resolve) => {
    seq += 1;
    pending = {
      id: `ask-${seq}`,
      channelId,
      label,
      url,
      decide: (allow) => { resolve(allow); },
    };
    emit();
  });
}

export function answerConfirm(id: string, allow: boolean): void {
  if (!pending || pending.id !== id) return;
  const p = pending;
  pending = null;
  emit();
  p.decide(allow);
}

/** 채널을 떠나거나 패널이 닫힐 때 — 답 없는 확인은 거절로 정리(두뇌가 영원히 안 기다리게). */
export function cancelPendingFor(channelId: string): void {
  if (!pending || pending.channelId !== channelId) return;
  const p = pending;
  pending = null;
  emit();
  p.decide(false);
}

// ---- 콘솔 링버퍼(탭별) ----
// <webview>의 console-message 이벤트를 BrowserView가 흘려 넣는다. 두뇌가 browser_console로 읽는다.

export function pushConsole(tabId: string, line: string): void {
  const next = [...(consoles.get(tabId) ?? []), line].slice(-MAX_CONSOLE);
  consoles.set(tabId, next);
}

export function consoleLines(tabId: string | null | undefined): string[] {
  return tabId ? consoles.get(tabId) ?? [] : [];
}

export function clearConsole(tabId: string): void {
  consoles.delete(tabId);
}

/** 테스트 전용 초기화(모듈 전역 상태라 테스트 사이에 새면 안 된다). */
export function resetAgentStore(): void {
  logs.clear();
  consoles.clear();
  if (pending) pending.decide(false);
  pending = null;
  listeners.clear();
}
