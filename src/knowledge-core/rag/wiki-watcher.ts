import { Injectable, OnModuleDestroy } from '@nestjs/common';
import chokidar, { FSWatcher } from 'chokidar';
import * as path from 'path';
import { PathResolver } from '../../pal/path-resolver';
import { RagStore } from './rag-store';
import { WikiEngine } from '../wiki/wiki-engine';

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
  ) {}

  async start(): Promise<void> {
    const glob = path.join(this.paths.getWikiPagesDir(), '*.md');
    this.watcher = chokidar.watch(glob, { ignoreInitial: true });
    this.watcher
      .on('add', (f) => this.debounce(this.slugOf(f), 'change'))
      .on('change', (f) => this.debounce(this.slugOf(f), 'change'))
      .on('unlink', (f) => this.debounce(this.slugOf(f), 'unlink'));
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.watcher?.close();
  }

  // 모듈 파괴 시 워처를 정리한다(jest 핸들 누수·좀비 워처 방지). NestJS app.close() 시 호출됨.
  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private slugOf(file: string): string {
    return path.basename(file, '.md');
  }

  private debounce(slug: string, event: 'change' | 'unlink'): void {
    const prev = this.timers.get(slug);
    if (prev) clearTimeout(prev);
    this.timers.set(
      slug,
      setTimeout(() => {
        this.timers.delete(slug);
        void this.handleChange(slug, event);
      }, DEBOUNCE_MS),
    );
  }

  // 현재 위키 상태를 보고 색인/제거를 결정한다(published만 색인 대상).
  async handleChange(slug: string, event: 'change' | 'unlink'): Promise<void> {
    if (event === 'unlink') {
      await this.rag.removePage(slug);
      return;
    }
    const page = await this.wiki.getPage(slug);
    if (page && page.frontmatter.status === 'published') {
      await this.rag.indexPage({
        slug: page.slug,
        title: page.frontmatter.title,
        category: page.frontmatter.category,
        sources: page.frontmatter.sources,
        body: page.body,
      });
    } else {
      await this.rag.removePage(slug); // draft로 내려갔거나 사라짐 → 색인에서 빼기
    }
  }
}
