import type { BrowserOp, BrowserOpResult } from '../../../shared/browser-ops';

// AI 웹 조작의 요청/응답 배선(2단계). 두뇌는 백엔드(자식 프로세스)에서 돌고 <webview>는 렌더러에
// 있으므로, 도구 호출 1건은 "채널로 op를 보내고 그 결과를 기다리는" 왕복이 된다. ws는 원래
// 단방향 push(ServerFrame)만 하던 길이라 그 위에 opId 짝맞춤만 얹는다.
//
// never-throw 계약: 어떤 실패(클라 없음·타임아웃·응답 형식 오류)도 예외가 아니라 ok:false 결과다 —
// 두뇌가 그 텍스트를 읽고 다음 수를 정한다(§3.1 도구 규율).

/** 렌더러가 늦게 답해도 영원히 매달리지 않는다. 사람 확인(허용 버튼)까지 기다릴 수 있어 넉넉히. */
export const BROWSER_OP_TIMEOUT_MS = 120_000;

type Sender = (channelId: string, opId: string, op: BrowserOp) => boolean;

export class BrowserBus {
  private readonly pending = new Map<string, { resolve: (r: BrowserOpResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private send: Sender | null = null;
  private seq = 0;

  constructor(private readonly timeoutMs: number = BROWSER_OP_TIMEOUT_MS) {}

  /** 소켓을 쥔 쪽(self.adapter)이 실제 전송 함수를 꽂는다. false=받을 클라가 없음. */
  setSender(send: Sender | null): void {
    this.send = send;
  }

  private nextId(): string {
    this.seq += 1;
    return `op-${Date.now().toString(36)}-${this.seq}`;
  }

  /** 조작 1건을 그 채널의 화면으로 보내고 결과를 기다린다. */
  request(channelId: string, op: BrowserOp): Promise<BrowserOpResult> {
    if (!this.send) {
      return Promise.resolve({ ok: false, text: 'browser error: no chat client is connected (open the Engram window)' });
    }
    const opId = this.nextId();
    const delivered = this.send(channelId, opId, op);
    if (!delivered) {
      return Promise.resolve({ ok: false, text: 'browser error: no chat client is connected (open the Engram window)' });
    }
    return new Promise<BrowserOpResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(opId);
        resolve({ ok: false, text: `browser error: timed out after ${Math.round(this.timeoutMs / 1000)}s (no answer from the screen)` });
      }, this.timeoutMs);
      // 타이머가 프로세스를 붙잡지 않게(테스트·종료 지연 방지).
      timer.unref?.();
      this.pending.set(opId, { resolve, timer });
    });
  }

  /** 렌더러 응답 도착. 모르는/이미 끝난 opId는 조용히 무시(늦은 응답·중복 응답 방어). */
  settle(opId: string, result: BrowserOpResult): void {
    const entry = this.pending.get(opId);
    if (!entry) return;
    this.pending.delete(opId);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }

  /** 대기 중인 호출 수(테스트·진단용). */
  get pendingCount(): number {
    return this.pending.size;
  }
}
