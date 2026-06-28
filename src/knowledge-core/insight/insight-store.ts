import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PathResolver, DEFAULT_USER } from '../../pal/path-resolver';
import { DayMetrics } from './metrics';

export interface DayInsight {
  date: string;        // YYYY-MM-DD
  metrics: DayMetrics;
  report: string;      // 두뇌 서술 요약
}

// 일일 인사이트 영속(설계 §5.4·spec A2). state/insights/{userId}/{day}.json — 위키 밖 운영 데이터.
@Injectable()
export class InsightStore {
  constructor(private readonly paths: PathResolver) {}

  async save(userId: string = DEFAULT_USER, insight: DayInsight): Promise<void> {
    const dir = this.paths.getInsightsDir(userId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${insight.date}.json`), JSON.stringify(insight, null, 2));
  }

  async latest(userId: string = DEFAULT_USER): Promise<DayInsight | null> {
    const files = await this.listDays(userId);
    if (files.length === 0) return null;
    return this.readFile(userId, files[files.length - 1]); // 파일명 정렬 = 날짜 오름차순
  }

  async get(userId: string = DEFAULT_USER, date: string): Promise<DayInsight | null> {
    return this.readFile(userId, `${date}.json`);
  }

  // 오래된 일일 인사이트 정리(보존정책). 최신 keep개만 남기고 삭제. keep<=0/비유한이면 무동작.
  async prune(userId: string = DEFAULT_USER, keep: number): Promise<void> {
    if (!Number.isFinite(keep) || keep <= 0) return;
    const files = await this.listDays(userId); // 날짜 오름차순
    const remove = files.slice(0, Math.max(0, files.length - keep));
    for (const f of remove) {
      await fs.unlink(path.join(this.paths.getInsightsDir(userId), f)).catch(() => {}); // best-effort
    }
  }

  private async listDays(userId: string): Promise<string[]> {
    try { return (await fs.readdir(this.paths.getInsightsDir(userId))).filter((f) => f.endsWith('.json')).sort(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  }

  private async readFile(userId: string, name: string): Promise<DayInsight | null> {
    let text: string;
    try { text = await fs.readFile(path.join(this.paths.getInsightsDir(userId), name), 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    try { return JSON.parse(text) as DayInsight; }
    catch { return null; } // 손상/반쓰기 파일은 인사이트 없음으로 강등(읽기 경로 보호)
  }
}
