import * as path from 'path';
import { Inject, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PathResolver, DEFAULT_USER } from '../pal/path-resolver';
import { WikiEngine } from './wiki/wiki-engine';
import { WikiGit } from './wiki/wiki-git';
import { WikiPage } from './wiki/page.types';
import { importSplitStorePages } from './wiki/split-store';
import { EMBEDDER } from './rag/embedder.port';
import { TransformersEmbedder } from './rag/transformers-embedder';
import { CachingEmbedder } from './rag/caching-embedder';
import { RagStore, withBootRetry, BootRetryOptions } from './rag/rag-store';
import { WikiWatcher } from './rag/wiki-watcher';
import { IndexablePage, PAGE_INDEXER } from './rag/rag.types';
import { KeyedLock } from './keyed-lock';
import { PinoLogger } from '../pal/logger';
import { ConversationStore } from './conversation-store';
import { ImportanceGate } from './importance-gate';
import { ProposalStore } from './proposal-store';
import { DigestLock } from './digest-lock';
import { TaskStore } from './task-store';
import { ProjectStore } from './project-store';
import { CodingGit } from './coding-git';
import { InsightStore } from './insight/insight-store';
import { InsightContext } from './insight/insight-context';
import { BootStage, markBootStage } from '../pal/boot-progress';

// 부트 재시도 튜닝값 — 테스트가 overrideProvider로 attempts/baseDelayMs/maxDelayMs를 작게 줄여
// 실시간 대기 없이 재시도 경로를 검증할 수 있게 DI 토큰으로 분리(knowledge-core.module.spec.ts).
export const BOOT_RETRY_OPTIONS = 'BOOT_RETRY_OPTIONS';
export type BootRetryTuning = Pick<BootRetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs'>;

// 격리(quarantine) 후 재생성된 빈 rag에 대한 백그라운드 전체 재색인 시작 지연(ms) — 부팅 자체를
// 늦추지 않기 위한 지연 시작. 테스트가 overrideProvider로 짧게 줄여 실시간 대기 없이 검증한다.
export const REINDEX_DELAY_MS = 'REINDEX_DELAY_MS';

// KnowledgeCore: 단일 진실원(설계 §5). 시작 시 위키 git + RAG 색인을 보장한다.
@Module({
  providers: [
    { provide: PathResolver, useFactory: () => new PathResolver() },
    // ★2026-07-19 실사고: 앱 부팅과 헤드리스 MCP가 동시에 같은 rag 폴더를 열면 RagStore.init()이
    // "Panic in async function"으로 죽어 크래시루프를 탔다 — 앱 부팅이 우선권을 갖도록 재시도.
    { provide: BOOT_RETRY_OPTIONS, useValue: { attempts: 5, baseDelayMs: 2000, maxDelayMs: 8000 } as BootRetryTuning },
    // ★2026-07-20 근본픽스: 부트 재시도가 소진돼도 손상이 남아있을 수 있다(부분생성 잔해로
    // open·create 둘 다 실패하는 "Table 'chunks' was not found ... _versions" 등) — 그 경우
    // 격리(rename) 후 빈 폴더에 재생성하고, 코퍼스 재색인은 부팅을 막지 않게 30초 지연 후 시작.
    { provide: REINDEX_DELAY_MS, useValue: 30_000 },
    WikiGit,
    // 페이지별 쓰기 직렬화 락 — WikiEngine·WikiWatcher 공유(§10.3).
    KeyedLock,
    // 구조화 로깅(pino) — WikiWatcher·KnowledgeCoreModule에 주입된다.
    PinoLogger,
    // TransformersEmbedder를 standalone provider로 등록 후 CachingEmbedder로 감쌈.
    // EMBEDDER override 시(테스트 등) 팩토리가 우회돼 FakeEmbedder가 직접 주입된다.
    TransformersEmbedder,
    {
      provide: EMBEDDER,
      useFactory: (base: TransformersEmbedder) => new CachingEmbedder(base),
      inject: [TransformersEmbedder],
    },
    RagStore,
    { provide: PAGE_INDEXER, useExisting: RagStore },
    WikiWatcher,
    WikiEngine,
    ConversationStore,
    { provide: ImportanceGate, useFactory: () => new ImportanceGate() },
    ProposalStore,
    DigestLock,
    {
      provide: TaskStore,
      useFactory: (paths: PathResolver, lock: KeyedLock) => new TaskStore(paths.getStateDir(), lock),
      inject: [PathResolver, KeyedLock],
    },
    // ProjectStore: config/projects/ 디렉터리 기반 코딩 프로젝트 설정 저장(설계 §5.2).
    {
      provide: ProjectStore,
      useFactory: (paths: PathResolver) => new ProjectStore(paths.getProjectsDir()),
      inject: [PathResolver],
    },
    // CodingGit: 타깃 외부 repo git 운전(설계 §4). 경로는 호출자(Orchestrator)가 제공.
    CodingGit,
    // InsightStore: 일일 인사이트 JSON 영속(설계 §5.4). state/insights/{userId}/에 저장.
    { provide: InsightStore, useFactory: (paths: PathResolver) => new InsightStore(paths), inject: [PathResolver] },
    // InsightContext: 최신 인사이트를 ReaderAgent 주입용 문자열로(설계 §5.4·spec A3).
    { provide: InsightContext, useFactory: (store: InsightStore) => new InsightContext(store), inject: [InsightStore] },
  ],
  exports: [PathResolver, WikiEngine, RagStore, PinoLogger, ConversationStore, ImportanceGate, ProposalStore, DigestLock, TaskStore, ProjectStore, CodingGit, InsightStore, InsightContext],
})
export class KnowledgeCoreModule implements OnModuleInit, OnModuleDestroy {
  // 백그라운드 재색인 지연 타이머 — onModuleDestroy에서 정리해 좀비 타이머/jest 핸들 누수를 막는다.
  private reindexTimer?: NodeJS.Timeout;

  constructor(
    private readonly git: WikiGit,
    private readonly wiki: WikiEngine,
    private readonly rag: RagStore,
    private readonly watcher: WikiWatcher,
    private readonly logger: PinoLogger,
    @Inject(BOOT_RETRY_OPTIONS) private readonly bootRetryOptions: BootRetryTuning,
    @Inject(REINDEX_DELAY_MS) private readonly reindexDelayMs: number,
    // 부팅 단계 보고(2026-07-26)를 쓸 데이터 폴더. 리슨 전에는 셸에 정보를 실어 보낼 통로가
    // 상태 파일뿐이다 — pal/boot-progress.ts 주석 참고.
    private readonly paths: PathResolver,
  ) {}

  // 단계 기록은 계측일 뿐이라 절대 부팅을 방해하면 안 된다(markBootStage 자체가 never-throw).
  private stage(stage: BootStage, extra?: { done?: number; total?: number }): void {
    markBootStage(this.paths.getDataDir(), stage, extra);
  }

  async onModuleInit(): Promise<void> {
    try {
      this.stage('wiki');
      await this.git.ensureRepo();

      // ★샌드박스에 갇힌 페이지를 데려온다(2026-07-30). MCP 서버가 패키지 컨테이너 안에서 돌면
      // Windows가 그 쓰기를 컨테이너 오버레이로 보내고, 안에서는 합쳐진 뷰만 보여 갈라진 걸 알 수도
      // 없다. 컨테이너 안에서는 진짜 폴더에 쓸 방법이 아예 없으므로(%APPDATA% 전체가 가상화),
      // 가상화 밖에 있는 이쪽이 정리한다. 경고만 찍던 걸 실제 이동으로 바꿨다 — 11장이 몇 주 갇혀
      // 있었고 사용자가 손으로 옮겼다. ensureRepo 뒤에 두는 이유: 가져온 페이지가 이번 부팅의
      // 재색인에 포함되고, git 저장소가 이미 준비된 상태여야 다음 커밋이 이 파일들을 담는다.
      await this.importSandboxedPages();

      // ★근본픽스(2026-07-20): RAG 초기화 실패는 더 이상 이 메서드를 throw로 죽이지 않는다.
      // git.ensureRepo()·wiki 재색인·watcher 시작 등 그 외 단계 실패는 오늘과 동일하게 throw
      // (부트 자체가 의미 없는 상태라 판단 — 이번 근본픽스는 실사고 2건 모두의 진앙인 RAG(Lance)
      // 경로에 한정한다). ragState: 'ok'=정상 오픈, 'healed'=격리+재생성 성공(코퍼스 빔),
      // 'degraded'=격리도 실패(검색·색인 비활성, 프로세스는 계속 실행).
      this.stage('rag');
      const ragState = await this.bootRag();

      if (ragState === 'ok') {
        // 시작 시 published 페이지 전체 재색인(모듈이 조율 → RagStore가 WikiEngine을 역의존하지 않음).
        // 현재 단일사용자 = DEFAULT_USER. reindexAll은 watcher.start() 전이라 동시 쓰기원이 없다(락 불필요).
        const pages = await this.wiki.listPages({ status: 'published' }, DEFAULT_USER);
        // 여기가 부팅에서 가장 오래 걸리는 구간이다(첫 페이지에서 임베딩 모델 ~2.1GB가 로드된다).
        // 페이지마다 진행을 남겨야 "몇 분째 같은 화면"과 "느리지만 전진 중"이 화면에서 갈린다.
        this.stage('index', { done: 0, total: pages.length });
        await this.rag.reindexAll(
          pages.map((p) => this.toIndexable(p)),
          (done, total) => this.stage('index', { done, total }),
        );
      } else if (ragState === 'healed') {
        // 격리 직후 코퍼스가 비어 있다 — 부팅을 지연시키지 않게 백그라운드로 전체 재색인을 예약한다.
        this.scheduleBackgroundReindex();
      }
      // ragState === 'degraded'면 재색인을 건너뛴다 — RagStore 내부 ready 가드가 검색은 빈 배열,
      // 색인은 no-op으로 항상 안전하게 처리한다(소비자 크래시 없음).

      await this.watcher.start();
    } catch (err) {
      // 한 단계 실패가 프로세스를 죽이지 않게 로깅(설계 §10.3). 데이터는 runtime/에 보존.
      this.logger.error('KnowledgeCore 초기화 실패', String(err), 'KnowledgeCoreModule');
      throw err;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.reindexTimer) clearTimeout(this.reindexTimer);
  }

  // 갈라진(샌드박스) 저장소에서 페이지를 데려온다. 계측이 본 작업을 막지 못하게 never-throw —
  // 파일을 못 옮겨도 부팅은 계속돼야 한다(오늘의 교훈: 한 장의 문제가 앱을 못 켜게 하면 안 된다).
  private async importSandboxedPages(): Promise<void> {
    try {
      const r = importSplitStorePages(this.paths.getDataDir());
      if (r.imported.length > 0) {
        // ★가져온 파일은 반드시 커밋한다(2026-07-30 실측으로 발견한 구멍). WikiEngine의 모든 쓰기는
        // commitAll(msg, relPath)로 **경로를 지정해** 커밋하므로, 파일만 복사하면 영영 untracked로
        // 남는다 — git 원격 동기화를 쓰는 사용자에게는 가져온 페이지가 다른 기기로 가지 않고,
        // 버전 관리되는 지식 베이스인데 가져온 사실이 이력에 안 남는다. (유실 위험은 없다: pull은
        // merge고 코드베이스에 git clean이 없어서 untracked 파일이 지워지지는 않는다.)
        // 경로를 하나씩 지정해 커밋한다 — add('.')로 쓸어담으면 무관한 더티 상태까지 끌어온다.
        for (const rel of r.imported) {
          try {
            await this.git.commitAll(`import ${rel} (sandboxed store)`, path.join('pages', rel));
          } catch (err) {
            this.logger.warn(`가져온 페이지 커밋 실패(파일은 이미 제자리에 있습니다): ${rel} — ${String(err)}`, 'KnowledgeCoreModule');
          }
        }
        this.logger.log(
          `샌드박스에 갇혀 있던 위키 페이지 ${r.imported.length}장을 가져왔습니다(${r.from.join(', ')}): ${r.imported.join(', ')}`,
          'KnowledgeCoreModule',
        );
      }
      // 충돌은 매 부팅 반복된다(가져오지 않으니 상태가 그대로다) — 실측: 사용자 머신에서 11장이
      // 걸렸고 전부 분류만 낡은 사본이었다(`category: external` vs 정리된 폴더명). 그래서 파일명을
      // 다 늘어놓지 않고 요약만 남긴다. 조용히 삼키지도 않는다 — 진짜로 앱 쪽이 잘못된 경우
      // 사람이 이 줄을 보고 찾아갈 수 있어야 한다.
      if (r.conflicts.length > 0) {
        const head = r.conflicts.slice(0, 3).join(', ');
        const rest = r.conflicts.length > 3 ? ` 외 ${r.conflicts.length - 3}장` : '';
        this.logger.log(
          `갈라진 저장소에 이름은 같고 내용이 다른 사본 ${r.conflicts.length}장이 있습니다 — 이쪽을 최신으로 보고 그대로 뒀습니다(${head}${rest})`,
          'KnowledgeCoreModule',
        );
      }
    } catch (err) {
      this.logger.warn(`샌드박스 페이지 가져오기 실패(건너뜀): ${String(err)}`, 'KnowledgeCoreModule');
    }
  }

  // WikiPage → RagStore 색인용 평탄 타입(§5.2). 정상 부팅 경로·백그라운드 재색인 양쪽이 공유.
  private toIndexable(p: WikiPage): IndexablePage {
    return {
      userId: DEFAULT_USER,
      slug: p.slug,
      title: p.frontmatter.title,
      category: p.frontmatter.category,
      sources: p.frontmatter.sources,
      body: p.body,
    };
  }

  // RAG open()을 부트 우선권으로 재시도하고, 그래도 소진되면(패닉이든 부분생성 잔해
  // "_versions not found"든 무엇이든) 손상 격리(rename) 후 빈 폴더에 재생성을 한 번 더 시도한다
  // (부트 자가치유, 근본픽스 2026-07-20). 격리 rename 자체가 실패하면(EBUSY 등) RagStore가 몇 차례
  // 재시도 후 포기 — 그 경우도 여기서 잡아 디그레이드로 폴백한다(오늘보다 더 나쁘게 죽지 않는다).
  private async bootRag(): Promise<'ok' | 'healed' | 'degraded'> {
    try {
      // retryAll: true(리뷰 후속) — 부트는 Lance 패턴이 아닌 에러(예: AV/OneDrive의 일시적 파일 락)도
      // 전체 백오프 스케줄로 재시도한다. 패턴 매칭만 재시도하면 그 외 모든 에러가 1회차에 즉시
      // quarantineAndReinit으로 떨어져 건강한 스토어를 오탐 격리(전체 재임베드 비용+rag.corrupt-* 누적)
      // 해버린다 — 격리는 전 재시도를 소진한 뒤에만 일어나야 한다.
      await withBootRetry(() => this.rag.init(), {
        ...this.bootRetryOptions,
        retryAll: true,
        onRetry: (attempt, err, delayMs) => {
          this.logger.warn(
            `KnowledgeCore RAG 초기화 재시도 ${attempt}회차(${delayMs}ms 후 재시도, 크로스 프로세스 경합 추정): ${err.message}`,
            'KnowledgeCoreModule',
          );
        },
      });
      return 'ok';
    } catch (err) {
      this.logger.error(
        'KnowledgeCore RAG 초기화 실패(재시도 소진) — 손상 격리 후 재생성 시도',
        String(err),
        'KnowledgeCoreModule',
      );
      try {
        await this.rag.quarantineAndReinit();
        this.logger.warn(
          'RAG 폴더 격리·재생성 성공 — 코퍼스는 백그라운드 재색인으로 복구(부팅 자가치유)',
          'KnowledgeCoreModule',
        );
        return 'healed';
      } catch (reinitErr) {
        this.logger.error(
          'RAG 격리·재생성도 실패 — 디그레이드로 폴백(검색·색인 비활성, 프로세스는 계속 실행)',
          String(reinitErr),
          'KnowledgeCoreModule',
        );
        return 'degraded';
      }
    }
  }

  // 격리·재생성 직후 빈 코퍼스를 백그라운드로 채운다. 상주 게이트(ENGRAM_RESIDENT — digest/insight/
  // meeting 스케줄러와 동일한 house pattern)로 앱(상주)에서만 실행하고, cli.ts 같은 원샷 부팅에서는
  // 건너뛴다(원샷은 곧 종료되므로 무거운 백그라운드 작업을 예약할 이유가 없다 — 다음 상주 부팅이
  // 자연히 재색인을 이어받는다는 게 이 결정의 전제. main.ts가 앱 부팅 전에 ENGRAM_RESIDENT=1을
  // 세팅하므로 이 시점엔 이미 반영돼 있다). 지연 시작(기본 30초)으로 부팅 자체를 막지 않는다.
  private scheduleBackgroundReindex(): void {
    if (process.env.ENGRAM_RESIDENT !== '1') {
      this.logger.warn(
        '비상주 부팅(CLI 등) — 백그라운드 전체 재색인은 다음 상주(앱) 부팅으로 미룸',
        'KnowledgeCoreModule',
      );
      return;
    }
    this.reindexTimer = setTimeout(() => {
      void this.runFullReindex().catch((err) =>
        this.logger.error('백그라운드 전체 재색인 실패', String(err), 'KnowledgeCoreModule'),
      );
    }, this.reindexDelayMs);
    this.reindexTimer.unref?.(); // 이 타이머 하나 때문에 프로세스 종료가 막히지 않게.
  }

  // published 페이지를 순차 재색인한다. 페이지 하나가 실패해도(파싱 오류·임베딩 실패 등) 나머지를
  // 계속 진행 — 부분 실패가 전체 재색인을 중단시키지 않는다.
  private async runFullReindex(): Promise<void> {
    const pages = await this.wiki.listPages({ status: 'published' }, DEFAULT_USER);
    this.logger.log(`전체 재색인 시작(${pages.length}건)`, 'KnowledgeCoreModule');
    let ok = 0;
    for (const p of pages) {
      try {
        await this.rag.indexPage(this.toIndexable(p));
        ok++;
      } catch (err) {
        this.logger.error(`재색인 실패: ${p.slug}`, String(err), 'KnowledgeCoreModule');
      }
    }
    this.logger.log(`전체 재색인 완료(${ok}/${pages.length}건)`, 'KnowledgeCoreModule');
  }
}
