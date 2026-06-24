import { Inject, Injectable, Optional } from '@nestjs/common';
import { IndexablePage, PageIndexer, PAGE_INDEXER } from '../rag/rag.types';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PathResolver, DEFAULT_USER } from '../../pal/path-resolver';
import { serializePage, parsePage } from './page-serializer';
import { WikiPage, CreatePageInput, UpdatePageInput, PageStatus } from './page.types';
import { WikiGit } from './wiki-git';

// 위키 페이지의 버전관리형 저장소(설계 §5.1).
// .md 파일 CRUD + 출처/상태 메타데이터를 다룬다. (git 이력은 WikiGit가 담당 — Task 6)
// userId 네임스페이스로 다중 사용자 페이지를 격리한다(§5.2, Part 3).
@Injectable()
export class WikiEngine {
  constructor(
    private readonly paths: PathResolver,
    private readonly git: WikiGit,
    @Optional() @Inject(PAGE_INDEXER) private readonly indexer?: PageIndexer,
  ) {}

  // WikiPage → 색인용 평탄 타입. (RagStore가 WikiPage 전체에 의존하지 않게.)
  // userId를 포함해 사용자별 색인 범위 분리.
  private toIndexable(page: WikiPage, userId: string): IndexablePage {
    return {
      userId,
      slug: page.slug,
      title: page.frontmatter.title,
      category: page.frontmatter.category,
      sources: page.frontmatter.sources,
      body: page.body,
    };
  }

  // 절대 파일경로: wiki/pages/{userId}/{slug}.md
  private pagePath(slug: string, userId: string): string {
    return path.join(this.paths.getWikiPagesDir(userId), `${slug}.md`);
  }

  // wiki 루트 기준 상대경로(경로-스코프 커밋용).
  private relPath(slug: string, userId: string): string {
    return path.relative(this.paths.getWikiDir(), this.pagePath(slug, userId));
  }

  // 페이지 생성. 기본 상태는 draft(검증·승인 전 초안, §6).
  // 통째 교체 금지 원칙에 따라 이미 존재하면 덮어쓰지 않고 실패시킨다('wx').
  // userId 기본값 DEFAULT_USER — 기존 호출자 하위호환 유지.
  async createPage(input: CreatePageInput, userId: string = DEFAULT_USER): Promise<WikiPage> {
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
    await fs.mkdir(this.paths.getWikiPagesDir(userId), { recursive: true });
    await fs.writeFile(this.pagePath(input.slug, userId), serializePage(page), { flag: 'wx' });
    await this.git.commitAll(`create ${userId}/${input.slug}`, this.relPath(input.slug, userId));
    if (page.frontmatter.status === 'published') {
      await this.indexer?.indexPage(this.toIndexable(page, userId));
    }
    return page;
  }

  // 페이지 읽기. 없으면 null.
  // userId 기본값 DEFAULT_USER — 기존 호출자 하위호환 유지.
  async getPage(slug: string, userId: string = DEFAULT_USER): Promise<WikiPage | null> {
    try {
      const content = await fs.readFile(this.pagePath(slug, userId), 'utf8');
      return parsePage(slug, content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  // 페이지 수정. created는 보존하고 updated만 갱신한다.
  // userId 기본값 DEFAULT_USER — 기존 호출자 하위호환 유지.
  async updatePage(slug: string, patch: UpdatePageInput, userId: string = DEFAULT_USER): Promise<WikiPage> {
    const existing = await this.getPage(slug, userId);
    if (!existing) throw new Error(`Page not found: ${userId}/${slug}`);
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
    await fs.writeFile(this.pagePath(slug, userId), serializePage(updated));
    await this.git.commitAll(`update ${userId}/${slug}`, this.relPath(slug, userId));
    if (updated.frontmatter.status === 'published') {
      await this.indexer?.indexPage(this.toIndexable(updated, userId));
    }
    return updated;
  }

  // 페이지 목록. status로 선택 필터링.
  // userId 기본값 DEFAULT_USER — 기존 호출자 하위호환 유지.
  async listPages(
    filter?: { status?: PageStatus },
    userId: string = DEFAULT_USER,
  ): Promise<WikiPage[]> {
    const dir = this.paths.getWikiPagesDir(userId);
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
      const page = await this.getPage(f.slice(0, -3), userId);
      if (!page) continue;
      if (filter?.status && page.frontmatter.status !== filter.status) continue;
      pages.push(page);
    }
    return pages;
  }

  // draft → published 전환(승인 게이트 통과 시, §6 반영 지점).
  // userId 기본값 DEFAULT_USER — 기존 호출자 하위호환 유지.
  async publishPage(slug: string, userId: string = DEFAULT_USER): Promise<WikiPage> {
    const existing = await this.getPage(slug, userId);
    if (!existing) throw new Error(`Page not found: ${userId}/${slug}`);
    const published: WikiPage = {
      ...existing,
      frontmatter: {
        ...existing.frontmatter,
        status: 'published',
        updated: new Date().toISOString(),
      },
    };
    await fs.writeFile(this.pagePath(slug, userId), serializePage(published));
    await this.git.commitAll(`publish ${userId}/${slug}`, this.relPath(slug, userId));
    await this.indexer?.indexPage(this.toIndexable(published, userId));
    return published;
  }

  // published → draft 강등(공개 취소). publishPage 대칭.
  // 색인에서 제거한다(§5.2 stale 방지). 이미 draft면 멱등 no-op.
  // userId 기본값 DEFAULT_USER — 기존 호출자 하위호환 유지.
  async unpublishPage(slug: string, userId: string = DEFAULT_USER): Promise<WikiPage> {
    const existing = await this.getPage(slug, userId);
    if (!existing) throw new Error(`Page not found: ${userId}/${slug}`);
    // 이미 draft면 색인 제거 없이 현재 상태 그대로 반환(멱등).
    if (existing.frontmatter.status === 'draft') return existing;
    const draft: WikiPage = {
      ...existing,
      frontmatter: {
        ...existing.frontmatter,
        status: 'draft',
        updated: new Date().toISOString(),
      },
    };
    await fs.writeFile(this.pagePath(slug, userId), serializePage(draft));
    await this.git.commitAll(`unpublish ${userId}/${slug}`, this.relPath(slug, userId));
    await this.indexer?.removePage(slug, userId);
    return draft;
  }
}
