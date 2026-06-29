// 멘션 작업의 in-memory 상태 추적(Phase 6b-1). @Engram 상태 조회용.
// TaskStore와 별개 — TaskStore엔 목록/스레드 질의 API가 없고 추가는 과함.
// ponytail: in-memory·재시작 시 소실. 영속 추적은 6b-3(자가 스케줄).
export type TrackedState = 'running' | 'done' | 'failed';

export interface TrackedTask {
  id: string;
  question: string;
  team: string[];
  state: TrackedState;
  startedAt: string;
  finishedAt?: string;
}

const RECENT_KEEP = 5; // 스레드당 완료분 보존 개수(running은 전부 보존)

export class MentionTracker {
  private seq = 0;
  private byThread = new Map<string, TrackedTask[]>();

  start(threadKey: string, t: { question: string; team: string[] }, now = new Date().toISOString()): TrackedTask {
    const task: TrackedTask = {
      id: `m${this.seq++}`, question: t.question, team: t.team, state: 'running', startedAt: now,
    };
    const list = this.byThread.get(threadKey) ?? [];
    list.push(task);
    this.byThread.set(threadKey, list);
    return task;
  }

  finish(threadKey: string, id: string, state: 'done' | 'failed', now = new Date().toISOString()): void {
    const list = this.byThread.get(threadKey);
    if (!list) return;
    const task = list.find((x) => x.id === id);
    if (!task) return;
    task.state = state;
    task.finishedAt = now;
    // running은 전부 보존, 완료분은 최근 RECENT_KEEP개만(삽입순서 유지).
    const running = list.filter((x) => x.state === 'running');
    const finished = list.filter((x) => x.state !== 'running').slice(-RECENT_KEEP);
    this.byThread.set(threadKey, [...running, ...finished]);
  }

  status(threadKey: string): TrackedTask[] {
    return [...(this.byThread.get(threadKey) ?? [])].reverse(); // 최신순
  }
}
