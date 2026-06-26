import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Orchestrator } from '../agent-layer/orchestrator';
import { PinoLogger } from '../pal/logger';
import { DEFAULT_USER } from '../pal/path-resolver';

// cron 표현식은 5~6개 공백 구분 필드. 잘못된 env(필드 수 불일치 — 예: 사람이 읽는 문구)는
// 부팅 시 크래시 대신 기본값으로 폴백한다. (필드 값 자체가 틀린 경우는 cron 라이브러리가 잡는다.)
export function resolveCron(raw: string | undefined): string {
  const def = '0 3 * * *'; // 매일 03:00
  if (!raw) return def;
  const n = raw.trim().split(/\s+/).length;
  return n === 5 || n === 6 ? raw.trim() : def;
}

const DIGEST_CRON = resolveCron(process.env.ENGRAM_DIGEST_CRON);

// 주기 자율 다이제스트(설계 §9.2 in-process @Cron, OS cron 금지).
// cli.ts(원샷)는 즉시 app.close()되어 발화 안 함 — 상주(main.ts)에서만 실제 발화.
@Injectable()
export class DigestScheduler {
  constructor(private readonly orchestrator: Orchestrator, private readonly logger: PinoLogger) {}

  // 동시 실행 방지: `engram digest`(별도 cli.ts)와 이 틱이 겹쳐도 IngesterAgent.run의
  // DigestLock(파일 락)이 한 번에 하나만 돌게 한다(§11). 락 못 잡은 쪽은 건너뜀.
  @Cron(DIGEST_CRON)
  async tick(): Promise<void> {
    try {
      const s = await this.orchestrator.digest(DEFAULT_USER);
      this.logger.log(`자율 다이제스트: 제안 ${s.proposed}건`, 'DigestScheduler'); // PinoLogger.log(message, context)
    } catch (err) {
      this.logger.error('DigestScheduler.tick 실패', String(err), 'DigestScheduler');
    }
  }
}
