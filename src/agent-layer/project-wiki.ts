import { Injectable } from '@nestjs/common';
import { WikiEngine } from '../knowledge-core/wiki/wiki-engine';

// 프로젝트 findings 저장(설계 §5.3). 기존 위키 멀티유저 격리를 projects/{id} 네임스페이스로 재사용.
// 진행 중 알아낸 사실을 보존(자산) — 진행상태(TaskStore)와 달리 삭제하지 않는다.
@Injectable()
export class ProjectWiki {
  constructor(private readonly wiki: WikiEngine) {}

  private ns(projectId: string): string {
    return `projects/${projectId}`;
  }

  // findings 기록. 없으면 published 생성(RAG 검색 대상), 있으면 본문에 append(보존).
  async record(projectId: string, slug: string, title: string, body: string): Promise<void> {
    const userId = this.ns(projectId);
    const existing = await this.wiki.getPage(slug, userId);
    if (!existing) {
      await this.wiki.createPage(
        { slug, title, category: 'project', status: 'published', sources: [], body },
        userId,
      );
    } else {
      await this.wiki.updatePage(slug, { body: `${existing.body}\n\n${body}` }, userId);
    }
  }
}
