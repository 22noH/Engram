import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Orchestrator } from '../agent-layer/orchestrator';
import { PinoLogger } from '../pal/logger';
import { DEFAULT_USER } from '../pal/path-resolver';
import { resolveCron } from './digest.scheduler';

// 다이제스트(03:00) 뒤 04:00 기본. DigestScheduler와 동일 성질(상주에서만 발화, cli.ts 원샷은 무발화).
const INSIGHT_CRON = resolveCron(process.env.ENGRAM_INSIGHT_CRON, '0 4 * * *');

@Injectable()
export class InsightScheduler {
  constructor(private readonly orchestrator: Orchestrator, private readonly logger: PinoLogger) {}

  @Cron(INSIGHT_CRON)
  async tick(): Promise<void> {
    try {
      const ins = await this.orchestrator.insight(DEFAULT_USER);
      this.logger.log(ins ? `인사이트 생성: ${ins.date}` : '인사이트 생략(대화 없음)', 'InsightScheduler');
    } catch (err) {
      this.logger.error('InsightScheduler.tick 실패', String(err), 'InsightScheduler');
    }
  }
}
