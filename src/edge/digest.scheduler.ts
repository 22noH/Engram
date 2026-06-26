import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Orchestrator } from '../agent-layer/orchestrator';
import { PinoLogger } from '../pal/logger';
import { DEFAULT_USER } from '../pal/path-resolver';

// 주기 자율 다이제스트(설계 §9.2 in-process @Cron, OS cron 금지).
// cli.ts(원샷)는 즉시 app.close()되어 발화 안 함 — 상주(main.ts)에서만 실제 발화.
@Injectable()
export class DigestScheduler {
  constructor(private readonly orchestrator: Orchestrator, private readonly logger: PinoLogger) {}

  @Cron(process.env.ENGRAM_DIGEST_CRON ?? '0 3 * * *') // 기본 매일 03:00
  async tick(): Promise<void> {
    try {
      const s = await this.orchestrator.digest(DEFAULT_USER);
      this.logger.log(`자율 다이제스트: 제안 ${s.proposed}건`, 'DigestScheduler'); // PinoLogger.log(message, context)
    } catch (err) {
      this.logger.error('DigestScheduler.tick 실패', String(err), 'DigestScheduler');
    }
  }
}
