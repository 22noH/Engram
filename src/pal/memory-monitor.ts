import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';
import { PathResolver } from './path-resolver';
import { PinoLogger } from './logger';
import { loadAlertConfig, sendAlert } from './alerter';

export function isOverLimit(rssBytes: number, limitMb: number): boolean {
  return rssBytes > limitMb * 1024 * 1024;
}

interface MemoryMonitorDeps {
  limitMb?: number;
  keepSnapshots?: number;
  rssFn?: () => number;
  alertFn?: (event: string, message: string) => Promise<void>;
  snapshotFn?: () => string;
}

// 메모리 위생 감시(설계 §10.3). rss가 임계치 초과하면 알림 + heap 스냅샷(원인 특정). 쿨다운으로 폭주 방지.
// ponytail: 단순 임계치 — 정교한 누수 분석은 스냅샷을 사람이 본다.
@Injectable()
export class MemoryMonitor {
  private readonly limitMb: number;
  private readonly keepSnapshots: number;
  private readonly rssFn: () => number;
  private readonly alertFn: (event: string, message: string) => Promise<void>;
  private readonly snapshotFn: () => string;
  private alerted = false;

  constructor(private readonly paths: PathResolver, private readonly logger: PinoLogger, deps: MemoryMonitorDeps = {}) {
    this.limitMb = deps.limitMb ?? Number(process.env.ENGRAM_RSS_LIMIT_MB ?? 1024);
    const heapRaw = process.env.ENGRAM_HEAP_KEEP;
    this.keepSnapshots = deps.keepSnapshots ?? (heapRaw == null || heapRaw.trim() === '' ? 3 : Number(heapRaw));
    this.rssFn = deps.rssFn ?? (() => process.memoryUsage().rss);
    this.alertFn = deps.alertFn ?? ((e, m) => sendAlert(loadAlertConfig(paths.getConfigDir()), e, m));
    this.snapshotFn = deps.snapshotFn ?? (() => v8.writeHeapSnapshot(path.join(paths.getLogsDir(), `heap-${Date.now()}.heapsnapshot`)));
  }

  @Interval(5 * 60_000)
  sample(): void {
    const rss = this.rssFn();
    if (!isOverLimit(rss, this.limitMb)) { this.alerted = false; return; } // 정상 복귀 시 쿨다운 해제
    if (this.alerted) return;                                              // 이미 알림 — 쿨다운
    this.alerted = true;
    const mb = Math.round(rss / 1024 / 1024);
    let snap = '(스냅샷 생략)';
    try { snap = this.snapshotFn(); this.pruneSnapshots(); } catch (e) { this.logger.warn(`heap 스냅샷 실패: ${String(e)}`, 'MemoryMonitor'); }
    this.logger.warn(`메모리 임계치 초과: rss ${mb}MB > ${this.limitMb}MB. 스냅샷: ${snap}`, 'MemoryMonitor');
    void this.alertFn('memory-high', `rss ${mb}MB가 임계치 ${this.limitMb}MB 초과. heap 스냅샷: ${snap}`);
  }

  // 오래된 heap 스냅샷 정리(파일이 커서 누적 방지). 최신 keepSnapshots개만 유지. best-effort.
  private pruneSnapshots(): void {
    if (!Number.isFinite(this.keepSnapshots) || this.keepSnapshots <= 0) return; // 0/음수 = 무제한(전부 보존)
    try {
      const dir = this.paths.getLogsDir();
      const files = fs.readdirSync(dir).filter((f) => f.startsWith('heap-') && f.endsWith('.heapsnapshot')).sort(); // 파일명 ts = 시간순
      for (const f of files.slice(0, Math.max(0, files.length - this.keepSnapshots))) fs.unlinkSync(path.join(dir, f));
    } catch { /* best-effort */ }
  }
}
