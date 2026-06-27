import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { KeyedLock } from './keyed-lock';

export type TaskStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';
export type TaskKind = 'collaboration' | 'board-decision';

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

  private file(id: string): string {
    return path.join(this.stateDir, `${id}.json`);
  }

  private async write(rec: TaskRecord): Promise<void> {
    await fs.promises.mkdir(this.stateDir, { recursive: true });
    await fs.promises.writeFile(this.file(rec.id), JSON.stringify(rec, null, 2));
  }
}
