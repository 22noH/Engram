# Engram Phase 0 Part 3 — 설계 (KnowledgeCore 토대 완성)

> 최종 갱신: 2026-06-24 · 상태: **설계 확정, 구현 계획 착수 전**
> 기준선: `docs/DESIGN.md` · 선행: Part 1(WikiEngine), Part 2(RagStore, 머지 `8520fcb`)

이 문서는 Phase 0 Part 3의 단일 설계 기준선이다. Part 3는 KnowledgeCore의 **토대를 닫는 패스**다 — 새 기능보다 정합성(단일 라이터)·운영 위생·이월 정리에 집중한다.

---

## 1. 범위

**포함:**
1. **멀티유저 네임스페이싱** — `wiki/pages/{userId}/*.md`. 정체성 = `(userId, slug)`.
2. **페이지별 락** — 같은 페이지 쓰기 직렬화 + 워처↔동기색인 조율.
3. **unpublish 주경로** — published→draft 강등 + RAG 제거(별도 메서드).
4. **FTS optimize()** — 쓰기마다 호출(임계치·크론 없음).
5. **상주 위생** — pino 구조화 로깅 + lru-cache 임베딩 캐시 + 작업 경계 try/catch.

**연기(명시):**
- **수집 1경로 / IngesterAgent** → Phase 2. §6 검증 파이프라인은 `IBrainProvider`(Phase 1) 의존이라 Part 3 토대 밖.
- **한국어 BM25 토크나이저** → 설계상 한국어 의미검색은 bge-m3 벡터가 담당(Tantivy 기본 공백분할 허용).
- **벡터 ANN 인덱스 튜닝** → 데이터 증가 시.
- **워처 실파일 E2E 대규모 보강** → 멀티유저 경로 파싱 단위테스트 + 기존 통합 1개로 충분.

---

## 2. 결정 원장 (브레인스토밍 확정)

| 항목 | 결정 | 근거 |
|---|---|---|
| 수집 1경로 | Phase 2 연기 | brain(Phase 1) 의존, §6 파이프라인은 Phase 2 본체 |
| 락 방식 | **페이지별 락**(slug 키) | 다른 페이지 병렬, 같은 페이지 직렬 |
| git 인덱스 안전 | 경로-스코프 `add` + simple-git 인스턴스 큐 | 전역 공유 자원이라 락으론 부족 |
| RAG 직렬화 | `RagStore.enqueue` 전역 유지 | LanceDB 단일 라이터 |
| unpublish | **별도 `unpublishPage` 메서드** | `publishPage` 대칭, 상태전환을 update와 분리(부수효과 가시화) |
| FTS optimize | **쓰기마다 호출**, 숫자/크론 없음 | optimize는 성능 정비(정확성 무관), 개인 위키 쓰기 저volume |
| 위생 | pino + lru-cache **둘 다**(§10.3) | lru-cache 거처 = 임베딩 캐시 |
| 멀티유저 | **지금 도입**, API는 `DEFAULT_USER` 기본값 | 나중 마이그레이션 회피, 단일사용자 ergonomics 유지 |
| pino 통합 | pino 직접 + 얇은 LoggerService | nestjs-pino는 HTTP 지향, Gateway(Phase 1) 전엔 YAGNI |
| 새 의존성 | `pino`, `lru-cache` 추가. KeyedLock은 직접(무의존) | |

---

## 3. 컴포넌트별 변경

### 3.1 멀티유저 네임스페이싱 (먼저 — 정체성 변경)

- **`PathResolver`**: `DEFAULT_USER = 'default'` 상수 export. `getWikiPagesDir(userId = DEFAULT_USER)` → `wiki/pages/{userId}`. `getLogsDir()` 신설 → `runtime/logs` (pino용). git 루트(`getWikiDir`)는 불변 = `wiki/` (단일 repo).
- **`WikiEngine`**: 모든 공개 메서드 첫 인자에 `userId = DEFAULT_USER` 추가 — `createPage(userId, input)`, `getPage(userId, slug)`, `updatePage(userId, slug, patch)`, `listPages(userId, filter?)`, `publishPage(userId, slug)`, `unpublishPage(userId, slug)`. `pagePath`는 `getWikiPagesDir(userId)` 기반.
- **git 경로-스코프**: `commitAll(message)` → `commitAll(message, relPath)`. `relPath = pages/{userId}/{slug}.md`(wiki 루트 기준 상대). `add('.')` → `add(relPath)`. 삭제도 `add`가 스테이징(tracked 파일 삭제 기록).
- **`rag.types`**: `IndexablePage`에 `userId` 추가. `PageIndexer.removePage(slug)` → `removePage(userId, slug)`. `SearchResult`에 `userId` 추가(선택적 노출).
- **`RagStore`**: schema에 `userId: Utf8` 컬럼. chunk id = `${userId}/${slug}#${i}`. 멱등 delete 술어 = `userId = ? AND slug = ?`. `search(query, limit, userId = DEFAULT_USER)` — `.where(userId = ?)` 프리필터로 사용자 격리(벡터·FTS 양쪽 leg에 적용되는지 구현 시 확인). **스키마 마이그레이션**: RAG는 wiki에서 파생·시작 시 reindex되는 disposable store → init에서 기존 테이블에 `userId` 컬럼 없으면 drop+recreate(데이터 손실 없음).
- **`WikiWatcher`**: 감시 디렉토리 = `getWikiPagesDir(DEFAULT_USER)`의 **부모**(`wiki/pages`) 재귀 감시. 파일 경로에서 `{userId}/{slug}` 파싱(`path.relative(pagesRoot, file)` → split). `handleChange(userId, slug, event)`. RAG 호출에 userId 전달.

### 3.2 페이지별 락

- **`KeyedLock`** 신설(`src/knowledge-core/keyed-lock.ts`, `@Injectable`, ~15줄): `run<T>(key, fn): Promise<T>`. 내부 `Map<string, Promise>` 체인 — 같은 키는 직전 작업 완료 후 실행(성패 무관), 다른 키는 독립. 키 비면 맵에서 정리(누수 방지).
- **공유 주입**: `KnowledgeCoreModule` provider. `WikiEngine`·`WikiWatcher` 둘 다 주입 → 같은 인스턴스로 조율.
- **적용**: WikiEngine 쓰기 메서드(create/update/publish/unpublish) 본문을 `this.lock.run(`${userId}/${slug}`, async () => {...})`로 감쌈. 워처 `handleChange`도 동일 키로 감쌈.
- **워처 조율**: WikiEngine이 락 보유 중 파일 쓰기 → chokidar 발화 → 워처 `handleChange`가 같은 키 대기 → WikiEngine 완료(파일+git+rag) 후 획득 → **멱등 재색인**(delete→add라 무해). 데드락 없음(WikiEngine은 워처를 await 안 함). 중복은 멱등이라 그대로 둠(`ponytail:` 주석).
- **reindexAll**: 시작 시 `watcher.start()` **전**에 실행 → 동시 쓰기원 없음. 락 불필요, `RagStore.enqueue`로 LanceDB 안전. 이 불변(시작 순서)을 주석으로 명시.

### 3.3 unpublish 주경로

- **`WikiEngine.unpublishPage(userId, slug)`**: `publishPage` 대칭. getPage → 없으면 에러(`publishPage`와 동일); 이미 draft면 멱등 no-op으로 기존 페이지 반환; published면 `status='draft'` + `updated` 갱신 → writeFile → `commitAll('unpublish ...', relPath)` → `indexer?.removePage(userId, slug)`. 락으로 감쌈.
- `UpdatePageInput`에 `status` 추가하지 **않음**(상태전환은 명시적 메서드로만).

### 3.4 FTS optimize()

- **`RagStore`**: `indexPage`·`removePage`의 enqueue 작업 끝에서 `await this.table.optimize()` 호출. 임계치 카운터·스케줄러 **없음**. 접을 게 없으면 near-no-op.
- `ponytail:` 주석으로 천장 명시: *startup reindexAll이 페이지마다 optimize → 코퍼스 수백+ 시 배치/주기 인덱스로 승격(측정 후 결정, YAGNI)*.
- 비용 가정(쓰기마다 optimize가 개인 위키 volume에서 무시 가능)은 구현 전 LanceDB 문서로 1회 확인.

### 3.5 상주 위생

- **pino 로깅**: pino 인스턴스 1개 → `runtime/logs/engram.log`(+ dev는 stdout pretty). 얇은 Nest `LoggerService` 어댑터로 노출(`src/pal/logger.ts`). 기존 `console.error`(워처) 대체. nestjs-pino 미사용.
- **작업 경계 try/catch**: 워처 `handleChange`(이미 catch 있음 → 로거로), `onModuleInit` reindex, `KeyedLock.run` 경계에서 예외를 잡아 로깅(한 작업 실패가 프로세스를 안 죽이게, §10.3).
- **lru-cache 임베딩 캐시**: `CachingEmbedder implements IEmbedder` 데코레이터(`src/knowledge-core/rag/caching-embedder.ts`) — 내부 `IEmbedder`를 감싸 `text → vector`를 lru-cache로 캐싱. `embed(texts)`는 캐시 히트/미스 분리해 미스만 위임. max 크기는 생성자 인자(기본값 + `ponytail:` 주석 — 메모리 바운드 knob, 초과 시 LRU 축출이라 정확성 무관). 모듈 wiring: `EMBEDDER` = `CachingEmbedder`(TransformersEmbedder를 감쌈). FakeEmbedder 위에서 캐시 히트 테스트(실모델 로딩 없이).

---

## 4. 데이터 흐름 (쓰기 1건, 멀티유저+락)

```
publishPage(userId, slug)
  └ lock.run(`${userId}/${slug}`, …)         ← 같은 페이지 직렬
       ├ writeFile(wiki/pages/{userId}/{slug}.md)
       ├ commitAll('publish …', pages/{userId}/{slug}.md)   ← 경로-스코프 add
       │     (simple-git 인스턴스 큐가 인덱스 직렬화)
       └ indexer.indexPage({userId, slug, …})
             └ RagStore.enqueue(…)            ← LanceDB 단일 라이터
                  ├ delete(userId=? AND slug=?)
                  ├ add(chunks)
                  ├ ensureFts()
                  └ optimize()
  (병렬) chokidar 'change' 발화 → watcher.handleChange(userId, slug)
       └ lock.run(같은 키) → 대기 → 멱등 재색인(무해)
```

---

## 5. 테스트

- **KeyedLock**: 같은 키 직렬(순서 보장), 다른 키 병렬, 예외 후 다음 작업 진행, 키 정리.
- **경로-스코프 커밋**: 동시 2페이지(다른 slug) 쓰기 → 각각 독립 커밋(혼입 없음). 삭제가 커밋에 반영.
- **멀티유저 격리**: 다른 userId 같은 slug → 파일·RAG·검색 분리. `search(userId=A)`가 B 페이지 미반환.
- **unpublish**: published→`unpublishPage`→draft + RAG에서 제거(검색 미반환).
- **optimize**: indexPage/removePage 후 호출됨(스파이), 접을 것 없을 때 에러 없음.
- **CachingEmbedder**: 같은 text 2회 → 내부 embedder 1회만 호출(캐시 히트). max 초과 시 축출.
- **워처 멀티유저 경로 파싱**: `pages/{userId}/{slug}.md` → 올바른 (userId, slug).
- **회귀**: 기존 37 테스트(+2 opt-in) 그대로 통과. tsc/build 클린.

---

## 6. 파일 영향 요약

- 신설: `keyed-lock.ts`(+spec), `caching-embedder.ts`(+spec), `pal/logger.ts`(+spec).
- 수정: `path-resolver.ts`(userId/logs), `wiki-engine.ts`(userId+락+unpublish), `wiki-git.ts`(경로-스코프), `rag-store.ts`(userId+optimize+캐시 wiring), `rag.types.ts`(userId), `wiki-watcher.ts`(경로 파싱+userId+로거), `knowledge-core.module.ts`(KeyedLock·CachingEmbedder·Logger wiring).
- 불변: `page.types.ts`(`UpdatePageInput`에 status 추가 안 함 — 상태전환은 publish/unpublish 메서드로만).
- 의존성: `+pino`, `+lru-cache`.

---

## 7. 비범위·리스크

- **schema 마이그레이션**: RAG는 derived/disposable → drop+recreate로 흡수(설명 §3.1). wiki(.md+git)는 불변 — 멀티유저는 새 페이지가 `{userId}/`에 생기는 것이라 기존 flat 페이지는 수동 이전 필요. **현재 runtime/wiki는 로컬 dev 데이터라 무시 가능**(첫 사용자 = DEFAULT_USER로 시작).
- **검색 userId 프리필터**가 LanceDB 하이브리드(벡터+FTS) 양쪽에 적용되는지 = 구현 시 확인 항목(context7/실측).
- **optimize 비용** = 구현 전 1회 확인.
