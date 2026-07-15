import { Inject, Injectable, Optional } from '@nestjs/common';
import { IndexablePage, PageIndexer, PAGE_INDEXER, SearchResult } from '../rag/rag.types';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PathResolver, DEFAULT_USER } from '../../pal/path-resolver';
import { serializePage, parsePage } from './page-serializer';
import { WikiPage, CreatePageInput, UpdatePageInput, PageStatus } from './page.types';
import { WikiGit } from './wiki-git';
import { KeyedLock } from '../keyed-lock';

// 위키 페이지의 버전관리형 저장소(설계 §5.1).
// .md 파일 CRUD + 출처/상태 메타데이터를 다룬다. (git 이력은 WikiGit가 담당 — Task 6)
// userId 네임스페이스로 다중 사용자 페이지를 격리한다(§5.2, Part 3).
@Injectable()
export class WikiEngine {
  constructor(
    private readonly paths: PathResolver,
    private readonly git: WikiGit,
    // 페이지별 쓰기 직렬화 락(§10.3). 같은 페이지는 순차, 다른 페이지는 병렬.
    private readonly lock: KeyedLock,
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
  // 본문 전체(파일 쓰기·커밋·색인)를 락으로 감싸 동시 create 충돌을 직렬화한다.
  async createPage(input: CreatePageInput, userId: string = DEFAULT_USER): Promise<WikiPage> {
    return this.lock.run(`${userId}/${input.slug}`, async () => {
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
    });
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
  // read-modify-write 전체를 락으로 감싸 동시 수정에 의한 lost-update를 방지한다.
  async updatePage(slug: string, patch: UpdatePageInput, userId: string = DEFAULT_USER): Promise<WikiPage> {
    return this.lock.run(`${userId}/${slug}`, async () => {
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
    });
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
  // read-modify-write 전체를 락으로 감싸 상태 전환 원자성을 보장한다.
  async publishPage(slug: string, userId: string = DEFAULT_USER): Promise<WikiPage> {
    return this.lock.run(`${userId}/${slug}`, async () => {
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
    });
  }

  // published → draft 강등(공개 취소). publishPage 대칭.
  // 색인에서 제거한다(§5.2 stale 방지). 이미 draft면 멱등 no-op.
  // userId 기본값 DEFAULT_USER — 기존 호출자 하위호환 유지.
  // early-return 포함 본문 전체를 락으로 감싸 read-modify-write 원자성을 보장한다.
  async unpublishPage(slug: string, userId: string = DEFAULT_USER): Promise<WikiPage> {
    return this.lock.run(`${userId}/${slug}`, async () => {
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
    });
  }

  // 게시된 페이지 본문 직접 교체(파괴적 — 사람 조작). updated만 갱신, 나머지 메타·status 보존.
  // updatePage(patch)와 동작이 겹치나 감사 이력에 'edit' 커밋을 남기려 별도 경로로 둔다.
  // ponytail: updatePage와 유사 — 분리 이유는 커밋 메시지(감사 신호)뿐. 통합하려면 커밋 메시지 인자화.
  // 없는 페이지 → throw(호출자가 흡수). 게시전용: draft는 throw(제안 흐름 소관 — 서버가 스코프 강제).
  // read-modify-write를 락으로 감싼다.
  async editPage(slug: string, body: string, userId: string = DEFAULT_USER): Promise<WikiPage> {
    return this.lock.run(`${userId}/${slug}`, async () => {
      const existing = await this.getPage(slug, userId);
      if (!existing) throw new Error(`Page not found: ${userId}/${slug}`);
      if (existing.frontmatter.status !== 'published') throw new Error(`Not published: ${userId}/${slug}`);
      const edited: WikiPage = {
        ...existing,
        frontmatter: { ...existing.frontmatter, updated: new Date().toISOString() },
        body,
      };
      await fs.writeFile(this.pagePath(slug, userId), serializePage(edited));
      await this.git.commitAll(`edit ${userId}/${slug}`, this.relPath(slug, userId));
      if (edited.frontmatter.status === 'published') {
        await this.indexer?.indexPage(this.toIndexable(edited, userId));
      }
      return edited;
    });
  }

  // 페이지 하드삭제(파괴적 — 사람 조작). 파일 unlink → 삭제 스테이징 커밋 → 색인 제거.
  // git add <path>가 삭제도 스테이징하므로(git 2.x) commitAll 재사용으로 충분(새 WikiGit 메서드 불필요).
  // 없는 페이지 → 멱등 no-op(false). 게시전용: draft도 no-op(false — 제안 흐름 소관, 서버가 스코프 강제).
  // 있으면 삭제하고 true. read-modify-write를 락으로 감싼다.
  async deletePage(slug: string, userId: string = DEFAULT_USER): Promise<boolean> {
    return this.lock.run(`${userId}/${slug}`, async () => {
      const existing = await this.getPage(slug, userId);
      if (!existing || existing.frontmatter.status !== 'published') return false;
      await fs.unlink(this.pagePath(slug, userId));
      await this.git.commitAll(`delete ${userId}/${slug}`, this.relPath(slug, userId));
      await this.indexer?.removePage(slug, userId);
      return true;
    });
  }

  // 위키 의미검색(읽기 전용 — 락·파일·커밋 없음). indexer(RagStore)에 위임.
  // 빈/공백 쿼리는 서버 왕복 없이 빈 배열. indexer 미주입(RAG 미탑재) 시에도 빈 배열.
  // RagStore는 청크 단위로 반환 — 한 페이지가 여러 청크로 쪼개지면 같은 slug가 여러 번 나온다.
  // 페이지 단위 검색이므로 slug로 중복 제거(순위 순서라 첫 등장=최상위 청크 유지). 중복 제거로
  // 결과가 줄어드니 넉넉히(limit*4) 가져와 뒤에서 limit개 페이지로 슬라이스한다.
  // ponytail: over-fetch 배수 4 — 한 페이지가 상위 4청크를 독식하면 결과가 limit 미만일 수 있으나
  // 개인/팀 위키 규모에선 충분. 부족이 실측되면 배수 상향 또는 페이지 단위 색인으로.
  async search(query: string, limit = 8, userId: string = DEFAULT_USER): Promise<SearchResult[]> {
    const q = query.trim();
    if (!q) return [];
    const rows = (await this.indexer?.search(q, limit * 4, userId)) ?? [];
    const seen = new Set<string>();
    const pages: SearchResult[] = [];
    for (const r of rows) {
      if (seen.has(r.slug)) continue;
      seen.add(r.slug);
      pages.push(r);
      if (pages.length >= limit) break;
    }
    return pages;
  }
}
