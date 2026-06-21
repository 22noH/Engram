import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PathResolver } from '../../pal/path-resolver';
import { serializePage, parsePage } from './page-serializer';
import { WikiPage, CreatePageInput, UpdatePageInput } from './page.types';
import { WikiGit } from './wiki-git';

// 위키 페이지의 버전관리형 저장소(설계 §5.1).
// .md 파일 CRUD + 출처/상태 메타데이터를 다룬다. (git 이력은 WikiGit가 담당 — Task 6)
@Injectable()
export class WikiEngine {
  constructor(
    private readonly paths: PathResolver,
    private readonly git: WikiGit,
  ) {}

  private pagePath(slug: string): string {
    return path.join(this.paths.getWikiPagesDir(), `${slug}.md`);
  }

  // 페이지 생성. 기본 상태는 draft(검증·승인 전 초안, §6).
  // 통째 교체 금지 원칙에 따라 이미 존재하면 덮어쓰지 않고 실패시킨다('wx').
  async createPage(input: CreatePageInput): Promise<WikiPage> {
    const now = new Date().toISOString();
    const page: WikiPage = {
      slug: input.slug,
      frontmatter: {
        title: input.title,
        category: input.category,
        status: input.status ?? 'draft',
        sources: input.sources ?? [],
        created: now,
        updated: now,
      },
      body: input.body,
    };
    await fs.mkdir(this.paths.getWikiPagesDir(), { recursive: true });
    await fs.writeFile(this.pagePath(input.slug), serializePage(page), {
      flag: 'wx',
    });
    await this.git.commitAll(`create ${input.slug}`);
    return page;
  }

  // 페이지 읽기. 없으면 null.
  async getPage(slug: string): Promise<WikiPage | null> {
    try {
      const content = await fs.readFile(this.pagePath(slug), 'utf8');
      return parsePage(slug, content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  // 페이지 수정. created는 보존하고 updated만 갱신한다.
  async updatePage(slug: string, patch: UpdatePageInput): Promise<WikiPage> {
    const existing = await this.getPage(slug);
    if (!existing) throw new Error(`Page not found: ${slug}`);
    const updated: WikiPage = {
      slug,
      frontmatter: {
        ...existing.frontmatter,
        title: patch.title ?? existing.frontmatter.title,
        category: patch.category ?? existing.frontmatter.category,
        sources: patch.sources ?? existing.frontmatter.sources,
        updated: new Date().toISOString(),
      },
      body: patch.body ?? existing.body,
    };
    await fs.writeFile(this.pagePath(slug), serializePage(updated));
    await this.git.commitAll(`update ${slug}`);
    return updated;
  }

  // 페이지 목록. status로 선택 필터링.
  async listPages(filter?: {
    status?: import('./page.types').PageStatus;
  }): Promise<WikiPage[]> {
    const dir = this.paths.getWikiPagesDir();
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const pages: WikiPage[] = [];
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const page = await this.getPage(f.slice(0, -3));
      if (!page) continue;
      if (filter?.status && page.frontmatter.status !== filter.status) continue;
      pages.push(page);
    }
    return pages;
  }

  // draft → published 전환(승인 게이트 통과 시, §6 반영 지점).
  async publishPage(slug: string): Promise<WikiPage> {
    const existing = await this.getPage(slug);
    if (!existing) throw new Error(`Page not found: ${slug}`);
    const published: WikiPage = {
      ...existing,
      frontmatter: {
        ...existing.frontmatter,
        status: 'published',
        updated: new Date().toISOString(),
      },
    };
    await fs.writeFile(this.pagePath(slug), serializePage(published));
    await this.git.commitAll(`publish ${slug}`);
    return published;
  }
}
