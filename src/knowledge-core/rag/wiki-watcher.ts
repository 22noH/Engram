import { Injectable, OnModuleDestroy } from '@nestjs/common';
import chokidar, { FSWatcher } from 'chokidar';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PathResolver, DEFAULT_USER } from '../../pal/path-resolver';
import { RagStore } from './rag-store';
import { WikiEngine } from '../wiki/wiki-engine';
import { KeyedLock } from '../keyed-lock';
import { PinoLogger } from '../../pal/logger';

const DEBOUNCE_MS = 300; // 윈도우 파일 잠금·연속 쓰기 흡수

// 위키 .md 변경을 감지해 RAG를 보조 재색인한다(주경로가 놓친 외부 편집 보정).
@Injectable()
export class WikiWatcher implements OnModuleDestroy {
  private watcher?: FSWatcher;
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly paths: PathResolver,
    private readonly rag: RagStore,
    private readonly wiki: WikiEngine,
    private readonly lock: KeyedLock,
    private readonly logger: PinoLogger,
  ) {}

  async start(): Promise<void> {
    // wiki/pages 전체(모든 userId 하위)를 재귀 감시하고 .md만 필터.
    const root = path.dirname(this.paths.getWikiPagesDir(DEFAULT_USER)); // = wiki/pages
    await fs.mkdir(root, { recursive: true });
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      ignored: (p, stats) => !!stats?.isFile() && !p.endsWith('.md'),
    });
    this.watcher
      .on('add', (f) => this.schedule(f, 'change'))
      .on('change', (f) => this.schedule(f, 'change'))
      .on('unlink', (f) => this.schedule(f, 'unlink'));
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.watcher?.close();
  }

  // 모듈 파괴 시 워처를 정리한다(jest 핸들 누수·좀비 워처 방지).
  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  // wiki/pages 기준 상대경로에서 {userId}/{slug}를 파싱한다. 형식이 아니면 null.
  private parseFile(file: string): { userId: string; slug: string } | null {
    const root = path.dirname(this.paths.getWikiPagesDir(DEFAULT_USER));
    const rel = path.relative(root, file);
    const parts = rel.split(path.sep);
    if (parts.length !== 2 || !parts[1].endsWith('.md')) return null; // {userId}/{slug}.md만
    return { userId: parts[0], slug: parts[1].slice(0, -3) };
  }

  private schedule(file: string, event: 'change' | 'unlink'): void {
    const parsed = this.parseFile(file);
    if (!parsed) return;
    const key = `${parsed.userId}/${parsed.slug}`;
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.handleChange(parsed.userId, parsed.slug, event).catch((err) =>
          this.logger.error(`재색인 실패 ${key}`, String(err), 'WikiWatcher'),
        );
      }, DEBOUNCE_MS),
    );
  }

  // 같은 페이지 키로 락을 잡아 WikiEngine 동기색인과 조율한다(멱등 — 중복 색인 무해).
  async handleChange(userId: string, slug: string, event: 'change' | 'unlink'): Promise<void> {
    await this.lock.run(`${userId}/${slug}`, async () => {
      if (event === 'unlink') {
        await this.rag.removePage(slug, userId);
        return;
      }
      const page = await this.wiki.getPage(slug, userId);
      if (page && page.frontmatter.status === 'published') {
        await this.rag.indexPage({
          userId,
          slug: page.slug,
          title: page.frontmatter.title,
          category: page.frontmatter.category,
          sources: page.frontmatter.sources,
          body: page.body,
        });
      } else {
        await this.rag.removePage(slug, userId); // draft로 내려갔거나 사라짐 → 색인 제거
      }
    });
  }
}
