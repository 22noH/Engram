import { Injectable } from '@nestjs/common';
import { WikiEngine } from '../knowledge-core/wiki/wiki-engine';
import { ProposalStore, Proposal } from '../knowledge-core/proposal-store';
import { t } from '../agent-layer/i18n';

// 승인된 제안을 op별로 위키에 반영(설계 §6 ⑥ 반영). 라이브 위키는 여기서만 변경.
@Injectable()
export class ProposalApplier {
  constructor(private readonly wiki: WikiEngine, private readonly proposals: ProposalStore) {}

  async apply(p: Proposal): Promise<void> {
    // create도 대상 존재를 먼저 본다 — 부분 실패(파일은 생겼는데 색인·승인 마킹 전 중단) 후
    // 재승인이 'wx' EEXIST로 영구히 막히는 좀비 제안 방지(2026-07-19 실사고).
    const existing = await this.wiki.getPage(p.targetSlug, p.userId);
    if (!existing) {
      await this.create(p); // create거나, append/supersede인데 대상 없으면 신규로 강등
    } else if (p.op === 'create' && existing.body.trim() === p.payload.trim()) {
      // 같은 내용이 이미 있음 = 지난 승인의 부분 반영 — publishPage(멱등)로 게시·색인만 마저 치유.
      await this.wiki.publishPage(p.targetSlug, p.userId);
    } else {
      const merged = [...new Set([...existing.frontmatter.sources, ...p.sources])];
      const marker = p.op === 'supersede'
        ? t('supersededMarker', p.id, p.sources.join(', '), p.payload)
        : `\n\n${p.payload}`;
      await this.wiki.updatePage(p.targetSlug, { body: existing.body + marker, sources: merged }, p.userId);
    }
    await this.proposals.markApproved(p.id);
  }

  private async create(p: Proposal): Promise<void> {
    await this.wiki.createPage(
      { slug: p.targetSlug, title: p.title, category: p.category, body: p.payload, sources: p.sources, status: 'published' },
      p.userId,
    );
  }

  async reject(p: Proposal): Promise<void> {
    await this.proposals.markRejected(p.id);
  }
}
