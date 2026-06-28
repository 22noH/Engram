import { Injectable } from '@nestjs/common';
import { InsightStore } from './insight-store';
import { DEFAULT_USER } from '../../pal/path-resolver';

// 최신 인사이트를 ReaderAgent 주입용 짧은 문자열로(설계 §5.4·spec A3). 없으면 ''.
@Injectable()
export class InsightContext {
  constructor(private readonly store: InsightStore) {}

  async latest(userId: string = DEFAULT_USER): Promise<string> {
    const ins = await this.store.latest(userId);
    if (!ins) return '';
    const terms = ins.metrics.topTerms.slice(0, 5).map((t) => t.term).join(', ');
    return `(${ins.date} 기준) ${ins.report}${terms ? `\n자주 다룬 주제: ${terms}` : ''}`;
  }
}
