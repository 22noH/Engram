import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { KeyedLock } from './keyed-lock';

export type TaskStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';
export type TaskKind = 'collaboration' | 'board-decision' | 'coding';

export interface CodingTicket {
  id: string;
  area: string;
  instruction: string;
  status: TaskStatus;
  attempts: number;
  gate: { pass: boolean; output: string } | null;
}

export interface TaskProgress {
  landed: number;
  criteriaMet: number;
  criteriaTotal: number;
}

const VALID: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ['RUNNING', 'FAILED'],
  RUNNING: ['SUCCESS', 'FAILED'],
  SUCCESS: [],
  FAILED: [],
};

export interface TaskRecord {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  question: string;
  assignees: string[];
  blackboard: Record<string, string>;
  result: string | null;
  createdAt: string;
  updatedAt: string;
  projectRef?: string;
  tickets?: CodingTicket[];
  progress?: TaskProgress;
}

// 협업/회의의 공유 블랙보드(설계 §5.1). runtime/state/*.json, 레코드별 KeyedLock 단일라이터.
// 진실은 여기(파일)에 — 에이전트는 stateless(Phase4 seam #2). 진전은 status·blackboard로 관측(seam #4).
@Injectable()
export class TaskStore {
  private seq = 0;
  constructor(
    private readonly stateDir: string,
    private readonly lock: KeyedLock,
  ) {}

  async create(input: { kind: TaskKind; question: string; assignees: string[] }): Promise<TaskRecord> {
    const now = new Date().toISOString();
    // id 충돌 방지: 타임스탐프 + 프로세스 내 단조 증가 시퀀스(Math.random 미사용 — 결정 가능·재현성).
    const id = `task_${now.replace(/[:.]/g, '-')}_${(this.seq++).toString(36)}`;
    const rec: TaskRecord = {
      id, kind: input.kind, status: 'PENDING', question: input.question,
      assignees: input.assignees, blackboard: {}, result: null, createdAt: now, updatedAt: now,
    };
    // create의 쓰기도 락 경유(공유 상태 직렬화 제약). id가 고유라 사실상 무경쟁이지만
    // "모든 쓰기는 KeyedLock 경유" 불변을 지킨다. write() 자체는 락을 걸지 않는다 —
    // 후속 mutate()가 lock.run(id) 안에서 write()를 호출하므로 중첩 시 데드락(재진입 불가).
    await this.lock.run(rec.id, () => this.write(rec));
    return rec;
  }

  async get(id: string): Promise<TaskRecord | null> {
    try {
      const raw = await fs.promises.readFile(this.file(id), 'utf8');
      return JSON.parse(raw) as TaskRecord;
    } catch {
      return null; // 없음/깨짐 → null(읽기는 락 불요)
    }
  }

  protected file(id: string): string {
    return path.join(this.stateDir, `${id}.json`);
  }

  transition(id: string, to: TaskStatus): Promise<TaskRecord> {
    return this.mutate(id, (rec) => {
      if (!VALID[rec.status].includes(to)) {
        throw new Error(`잘못된 전이: ${rec.status} → ${to} (${id})`);
      }
      rec.status = to;
    });
  }

  contribute(id: string, persona: string, text: string): Promise<TaskRecord> {
    return this.mutate(id, (rec) => { rec.blackboard[persona] = text; });
  }

  setResult(id: string, result: string): Promise<TaskRecord> {
    return this.mutate(id, (rec) => { rec.result = result; });
  }

  // 같은 레코드 동시변경을 KeyedLock으로 직렬화(read→수정→write 원자성).
  private mutate(id: string, fn: (rec: TaskRecord) => void): Promise<TaskRecord> {
    return this.lock.run(id, async () => {
      const rec = await this.get(id);
      if (!rec) throw new Error(`레코드 없음: ${id}`);
      fn(rec);
      rec.updatedAt = new Date().toISOString();
      await this.write(rec);
      return rec;
    });
  }

  private async write(rec: TaskRecord): Promise<void> {
    await fs.promises.mkdir(this.stateDir, { recursive: true });
    await fs.promises.writeFile(this.file(rec.id), JSON.stringify(rec, null, 2));
  }

  async createCoding(input: { question: string; projectRef: string; criteriaTotal: number }): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const id = `task_${now.replace(/[:.]/g, '-')}_${(this.seq++).toString(36)}_code`;
    const rec: TaskRecord = {
      id, kind: 'coding', status: 'PENDING', question: input.question,
      assignees: [], blackboard: {}, result: null, createdAt: now, updatedAt: now,
      projectRef: input.projectRef, tickets: [],
      progress: { landed: 0, criteriaMet: 0, criteriaTotal: input.criteriaTotal },
    };
    await this.lock.run(rec.id, () => this.write(rec));
    return rec;
  }

  addTickets(id: string, tickets: Array<{ id: string; area: string; instruction: string }>): Promise<TaskRecord> {
    return this.mutate(id, (rec) => {
      rec.tickets = rec.tickets ?? [];
      for (const t of tickets) rec.tickets.push({ ...t, status: 'PENDING', attempts: 0, gate: null });
    });
  }

  updateTicket(id: string, ticketId: string, patch: Partial<CodingTicket>): Promise<TaskRecord> {
    return this.mutate(id, (rec) => {
      const t = (rec.tickets ?? []).find((x) => x.id === ticketId);
      if (!t) throw new Error(`티켓 없음: ${ticketId}`);
      Object.assign(t, patch);
    });
  }

  recordProgress(id: string, patch: Partial<TaskProgress>): Promise<TaskRecord> {
    return this.mutate(id, (rec) => {
      rec.progress = { ...(rec.progress ?? { landed: 0, criteriaMet: 0, criteriaTotal: 0 }), ...patch };
    });
  }

  async remove(id: string): Promise<void> {
    await fs.promises.rm(this.file(id), { force: true });
  }

  // 진전 관측키(설계 §5.1 seam #4). 라운드 간 이 값이 안 바뀌면 stuck.
  static progressKey(rec: TaskRecord): string {
    const p = rec.progress ?? { landed: 0, criteriaMet: 0, criteriaTotal: 0 };
    return `${p.landed}:${p.criteriaMet}`;
  }
}
