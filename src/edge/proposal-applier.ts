import { Injectable } from '@nestjs/common';
import { WikiEngine } from '../knowledge-core/wiki/wiki-engine';
import { ProposalStore, Proposal } from '../knowledge-core/proposal-store';

// 승인된 제안을 op별로 위키에 반영(설계 §6 ⑥ 반영). 라이브 위키는 여기서만 변경.
@Injectable()
export class ProposalApplier {
  constructor(private readonly wiki: WikiEngine, private readonly proposals: ProposalStore) {}

  async apply(p: Proposal): Promise<void> {
    const existing = p.op === 'create' ? null : await this.wiki.getPage(p.targetSlug, p.userId);
    if (p.op === 'create' || !existing) {
      await this.create(p); // create거나, append/supersede인데 대상 없으면 신규로 강등
    } else {
      const merged = [...new Set([...existing.frontmatter.sources, ...p.sources])];
      const marker = p.op === 'supersede'
        ? `\n\n<!-- superseded by 제안 ${p.id} (출처: ${p.sources.join(', ')}) -->\n${p.payload}`
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
