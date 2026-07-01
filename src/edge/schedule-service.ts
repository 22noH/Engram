import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob, CronTime } from 'cron';
import { MessengerPort } from './messenger/messenger.port';
import { ScheduleStore, ScheduleEntry, SchedulerPort } from '../agent-layer/schedule-store';

// Orchestrator를 구조적 타입으로만 의존(순환 회피).
interface MentionRunner {
  handleMention(
    msg: { text: string; userId: string },
    post: (t: string) => Promise<void>,
    threadKey?: string,
  ): Promise<void>;
}

// 예약 런타임(Phase 6b-3, plain — main.ts 결선). cron 등록·발사·영속을 담당하고
// SchedulerPort로 Orchestrator에 노출. 발사는 저장된 task를 handleMention 재주입 → 채널 게시.
export class ScheduleService implements SchedulerPort {
  // 발사 중 재진입 깊이(재예약 자기복제 차단, Fix 2).
  private firingDepth = 0;

  constructor(
    private readonly orchestrator: MentionRunner,
    private readonly port: MessengerPort,
    private readonly registry: SchedulerRegistry,
    private readonly store: ScheduleStore,
    private readonly logger: { warn(msg: string, ctx?: string): void },
  ) {}

  // 부팅: 저장된 예약을 로드·등록(개별 실패는 스킵).
  start(): void {
    this.store.load();
    for (const e of this.store.all()) {
      try { this.register(e); }
      catch (err) { this.logger.warn(`예약 등록 실패(스킵) ${e.id}: ${String(err)}`, 'Schedule'); }
    }
  }

  add(input: { channelId: string; threadId?: string; cron: string; task: string; once?: boolean }): ScheduleEntry | null {
    if (this.firingDepth > 0) return null; // 발사 중 재예약 금지(재진입 루프 차단)
    if (!this.validCron(input.cron)) return null;
    const e = this.store.add(input);
    try { this.register(e); }
    catch (err) { this.logger.warn(`예약 등록 실패 ${e.id}: ${String(err)}`, 'Schedule'); }
    return e;
  }

  list(channelId: string): ScheduleEntry[] { return this.store.byChannel(channelId); }

  remove(id: string): boolean {
    try { this.registry.deleteCronJob(`sched-${id}`); } catch { /* 없으면 무시 */ }
    return this.store.remove(id);
  }

  // 발사: 저장된 task를 재주입, 채널에 게시. once면 발사 후 삭제.
  // ponytail: 재주입=완전자율(협업/코딩 뭐든). 매일 협업이면 매일 토큰 — 비용은 사용자 cron 책임.
  fire(e: ScheduleEntry): void {
    this.firingDepth++;
    void this.orchestrator
      .handleMention(
        { text: e.task, userId: e.channelId },
        (t) => this.port.postToChannel(e.channelId, t, e.threadId),
        e.threadId ?? e.channelId,
      )
      .catch((err) => this.logger.warn(`예약 실행 실패 ${e.id}: ${String(err)}`, 'Schedule'))
      .finally(() => { this.firingDepth--; });
    if (e.once) this.remove(e.id);
  }

  private validCron(expr: string): boolean {
    if (expr.trim().split(/\s+/).length !== 5) return false;
    try { new CronTime(expr); return true; } catch { return false; }
  }

  private register(e: ScheduleEntry): void {
    const job = this.makeJob(e.cron, () => this.fire(e));
    this.registry.addCronJob(`sched-${e.id}`, job as unknown as CronJob);
    job.start();
  }

  // 테스트에서 실 타이머를 피하려 job 생성을 seam으로 분리.
  protected makeJob(cron: string, onTick: () => void): { start(): void; stop(): void } {
    return new CronJob(cron, onTick) as unknown as { start(): void; stop(): void };
  }
}
