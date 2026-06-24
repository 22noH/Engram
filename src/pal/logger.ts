import { Injectable, LoggerService } from '@nestjs/common';
import pino, { Logger } from 'pino';
import * as path from 'path';
import { PathResolver } from './path-resolver';

// pino 구조화 로깅을 Nest LoggerService로 노출(설계 §10.3 "구조화 로깅 디스크 영속").
// runtime/logs/engram.log에 JSON 라인으로 영속한다. nestjs-pino는 HTTP 지향이라 직접 래핑.
// ponytail: sync 목적지 — 개인 위키는 로그 volume이 낮아 동기 쓰기로 충분(flush 레이스 제거).
//           핫패스 로깅이 생기면 sync:false + flush로 전환.
@Injectable()
export class PinoLogger implements LoggerService {
  private readonly logger: Logger;

  constructor(paths: PathResolver) {
    const dest = path.join(paths.getLogsDir(), 'engram.log');
    this.logger = pino(
      { level: process.env.ENGRAM_LOG_LEVEL ?? 'info' },
      pino.destination({ dest, mkdir: true, sync: true }),
    );
  }

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
