import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import * as fs from 'fs';
import { ChannelPoster } from './messenger/messenger.port';
import { ChannelPolicy, allows } from '../agent-layer/channel-policy';
import { ProposalStore } from '../knowledge-core/proposal-store';
import { resolveCron } from './digest.scheduler';
import { DEFAULT_USER } from '../pal/path-resolver';

// 인사이트 실행자(Orchestrator 구조적 타입 — 순환 회피).
interface InsightRunner {
  insight(userId: string, date?: string): Promise<{ date: string; report: string } | null>;
}

// ambient 조용한 출구(6c-1, plain — main.ts 결선): 매일 아침 채널마다
// ① 어제 인사이트 생성·요약 게시 ② 위키 결재 대기 알림. 채널별 실패 격리(상주 불사).
// 인사이트 생성은 reporter가 대화 없으면 null(두뇌 미호출)이라 사전 파일검사 불요.
export class AmbientService {
  constructor(
    private readonly orchestrator: InsightRunner,
    private readonly port: ChannelPoster,
    private readonly registry: SchedulerRegistry,
    private readonly proposals: ProposalStore,
    private readonly policy: ChannelPolicy,
    private readonly conversationsRoot: string, // {data}/state/conversations
    private readonly logger: { warn(msg: string, ctx?: string): void },
  ) {}

  start(): void {
    const cron = resolveCron(process.env.ENGRAM_AMBIENT_CRON, '0 8 * * *');
    const job = this.makeJob(cron, () => { void this.tick(); });
    this.registry.addCronJob('ambient', job as unknown as CronJob);
    job.start();
  }

  async tick(): Promise<void> {
    for (const channelId of this.channels()) {
      if (!allows(this.policy, channelId, 'ambient')) continue;
      try {
        const ins = await this.orchestrator.insight(channelId, this.yesterday());
        if (ins?.report) await this.port.postToChannel(channelId, `☀️ 어제 이 채널: ${ins.report}`);
        const pending = await this.proposals.listPending(channelId);
        if (pending.length > 0) {
          await this.port.postToChannel(channelId, `📋 위키 결재 대기 ${pending.length}건 — 터미널에서 engram review로 승인해줘`);
        }
      } catch (err) {
        this.logger.warn(`ambient 실패(스킵) ${channelId}: ${String(err)}`, 'Ambient');
      }
    }
  }

  // 채널 목록 = 대화 디렉토리명(userId=channelId). CLI 사용자(DEFAULT_USER)는 채널이 아님.
  private channels(): string[] {
    try {
      return fs.readdirSync(this.conversationsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name).filter((n) => n !== DEFAULT_USER);
    } catch {
      return []; // 루트 없음 = 대화 이력 없음
    }
  }

  // 테스트 seam(결정적 날짜·실 타이머 회피).
  protected yesterday(): string {
    return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  }
  protected makeJob(cron: string, onTick: () => void): { start(): void; stop(): void } {
    return new CronJob(cron, onTick) as unknown as { start(): void; stop(): void };
  }
}
