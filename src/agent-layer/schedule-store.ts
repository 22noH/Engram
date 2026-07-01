import * as fs from 'fs';
import * as path from 'path';

// 예약 엔트리(Phase 6b-3). schedules.json에 영속.
export interface ScheduleEntry {
  id: string;
  channelId: string;
  threadId?: string;
  cron: string;       // 표준 5필드
  task: string;       // 발사 시 재주입할 자연어 지시
  once?: boolean;     // true면 1회 발사 후 자기 삭제
  createdAt: string;
}

// Orchestrator가 보는 스케줄러 포트(구현=ScheduleService). add는 잘못된 cron이면 null.
export interface SchedulerPort {
  add(input: { channelId: string; threadId?: string; cron: string; task: string; once?: boolean }): ScheduleEntry | null;
  list(channelId: string): ScheduleEntry[];
  remove(id: string): boolean;
}

// runtime/config/schedules.json 영속(meeting-config 패턴). 쓰기마다 저장.
export class ScheduleStore {
  private entries: ScheduleEntry[] = [];
  private seq = 0;
  constructor(private readonly configDir: string) {}

  private file(): string { return path.join(this.configDir, 'schedules.json'); }

  load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      this.entries = Array.isArray(parsed) ? (parsed as ScheduleEntry[]) : [];
    } catch {
      this.entries = [];
    }
  }

  all(): ScheduleEntry[] { return [...this.entries]; }

  byChannel(channelId: string): ScheduleEntry[] {
    return this.entries.filter((e) => e.channelId === channelId);
  }

  add(input: { channelId: string; threadId?: string; cron: string; task: string; once?: boolean }): ScheduleEntry {
    const entry: ScheduleEntry = { id: this.newId(), createdAt: new Date().toISOString(), ...input };
    this.entries.push(entry);
    this.save();
    return entry;
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    const removed = this.entries.length < before;
    if (removed) this.save();
    return removed;
  }

  // 프로세스 내 단조 id + 타임스탬프(재현·충돌회피). Math.random 미사용.
  private newId(): string {
    return `s${Date.now().toString(36)}${(this.seq++).toString(36)}`;
  }

  private save(): void {
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(this.entries, null, 2));
  }
}
