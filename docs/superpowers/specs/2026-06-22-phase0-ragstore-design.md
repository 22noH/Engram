# Engram Phase 0 Part 2 — RagStore 설계

- 날짜: 2026-06-22
- 상태: 승인 대기 (brainstorming 산출물)
- 브랜치: `phase0-ragstore`
- 설계 기준선: `docs/DESIGN.md` §5.2 (RagStore), §7.6 (IEmbedder)
- 선행: Phase 0 Part 1 (버전관리형 WikiEngine, HEAD `9d7fc47`)

## 1. 배경·목표

Part 1에서 `.md` + frontmatter 기반의 버전관리형 위키(WikiEngine)를 만들었다.
Part 2는 그 위에 **검색 계층(RagStore)** 을 얹어, 위키 페이지를 의미·키워드 양쪽으로
검색할 수 있게 한다. 이것은 §7.2 ReaderAgent와 §6 검증 파이프라인 ④(모순 검사)의 토대다.

핵심 목표:

1. 위키의 published 페이지를 색인하고 **하이브리드 검색**(키워드 BM25 + 의미 벡터, RRF 융합)을 제공한다.
2. 임베딩 모델·벡터 저장소를 **포트 뒤에 숨겨** 교체 가능하게 한다(`IEmbedder`).
3. 위키 쓰기와 RAG 재색인을 묶어 **stale 읽기**(갱신 직후 옛 검색 결과)를 막는다.
4. 모든 것이 **로컬·임베디드·상시 프로세스 0개**로 동작한다(설계 §2 윈도우 네이티브 우선).

## 2. 범위

**포함 (설계 §5.2 전부):**

- LanceDB 임베디드 저장소(`runtime/rag/`)
- 로컬 다국어 임베딩(bge-m3, `IEmbedder` 포트)
- 하이브리드 검색(LanceDB 네이티브 BM25 + 벡터, RRF reranker)
- 증분 색인(페이지 단위 멱등 upsert / remove)
- 파일 워처(chokidar) 보조 재색인

**제외 (Part 3+ 이월):**

- 단일-라이터 락(위키+RAG 공통) — 지금은 간단한 직렬 큐로 흡수
- 한국어 BM25 형태소 토크나이저
- 벡터 인덱스(IVF/HNSW) 튜닝 — 개인 규모라 우선 brute-force
- 멀티유저 네임스페이싱(`wiki/pages/{userId}/`)

## 3. 결정 요약

| 항목 | 결정 | 근거 |
|---|---|---|
| 벡터 저장소 | LanceDB (`@lancedb/lancedb`) | 임베디드·파일 기반, 하이브리드(FTS+벡터+RRF) 네이티브 내장, 윈도우 prebuilt |
| 임베딩 라이브러리 | transformers.js (`@huggingface/transformers`) | HF 공식·유지보수 활발, Node 서버사이드 완전 지원, `IEmbedder`로 교체 가능 |
| 임베딩 모델 | bge-m3 (1024차원) 우선, 대체 multilingual-e5-large | 품질 최우선(사용자 선택), 한·영 혼재 다국어 강함 |
| 하이브리드 구현 | LanceDB 네이티브 RRF | 설계 §5.2 "내장 FTS로 하이브리드"와 합치, 직접 구현 대비 단순 |
| 동기화 구조 | 동기 주경로(포트) + 워처 보조, 멱등 색인 | 갱신 직후 검색 일관성 + 외부편집/누락 보정. 두 경로 겹쳐도 안전 |
| 색인 대상 | published 페이지만 | 설계 §6 "진실원" 원칙. 미검증 draft가 RAG 답변을 오염하지 않게 |

## 4. 아키텍처 — 포트와 어댑터

```
knowledge-core/
 └ rag/
    ├ embedder.port.ts        # IEmbedder 인터페이스 + 토큰
    ├ transformers-embedder.ts# bge-m3 어댑터 (transformers.js)
    ├ fake-embedder.ts        # 결정론적 테스트용 어댑터
    ├ chunker.ts              # 페이지 본문 → 청크[]
    ├ rag-store.ts            # LanceDB: index/remove/reindex/search (PAGE_INDEXER 구현)
    ├ wiki-watcher.ts         # chokidar 보조 재색인
    └ rag.types.ts            # Chunk, SearchResult, PageIndexer 포트
```

- **`IEmbedder`** (포트): `embed(texts: string[]): Promise<number[][]>`, `readonly dimensions: number`.
  두뇌(`IBrainProvider`)·임베더(§7.6)와 동일한 포트+어댑터 패턴.
- **`TransformersEmbedder`**: transformers.js `pipeline("feature-extraction", model, { pooling: "mean", normalize: true })`.
  첫 호출 시 모델 1회 다운로드 후 로컬 캐시. 모델 ID는 구현 1번 태스크에서 실제 로딩으로 확정.
- **`FakeEmbedder`**: 텍스트 해시 → 고정 차원 단위벡터. 네트워크·다운로드 없이 결정론적. 단위테스트 기본 어댑터.
- **`Chunker`**: 본문을 마크다운 헤딩(`#`) 섹션 → 너무 길면 문단(빈 줄) 단위로 분할 + 문자 상한.
  짧은 페이지는 1청크. 청크가 검색·표시 단위.
- **`RagStore`**: LanceDB 연결·스키마 보장, `indexPage`/`removePage`/`reindexAll`/`search`.
  `PageIndexer` 포트를 구현한다.
- **`WikiWatcher`**: chokidar로 `runtime/wiki/pages/**/*.md` 감지. `.git`·잠금파일 무시, 디바운스.

## 5. 데이터 모델 — LanceDB `chunks` 테이블

| 컬럼 | 타입 | 용도 |
|---|---|---|
| `id` | Utf8 (`{slug}#{chunkIndex}`) | 청크 고유키(삭제·교체 단위) |
| `slug` | Utf8 | 페이지 식별(재색인·삭제 필터) |
| `chunkIndex` | Int32 | 페이지 내 청크 순서 |
| `title` | Utf8 | 결과 표시 |
| `category` | Utf8 | 결과 표시·필터 |
| `text` | Utf8 | 청크 원문 — **BM25 전문검색 대상** + 결과 본문 |
| `vector` | FixedSizeList<Float32>[dims] | 임베딩 — 의미검색 대상 |
| `sources` | List<Utf8> | 출처 포인터(§6 연계) |
| `updated` | Utf8 (ISO 8601) | 최신성 |

- `text` 컬럼에 `Index.fts()`(Tantivy BM25) 색인.
- 벡터는 개인 규모라 우선 인덱스 없이 brute-force. 데이터가 커지면 Part 3에서 ANN 인덱스.
- `dims`는 임베더의 `dimensions`로 결정(bge-m3 = 1024, fake = 임의 고정값 예: 64).

## 6. 핵심 흐름

### 6.1 색인 (`indexPage(page: WikiPage)`)

```
page → chunker.split(body) → chunks[]
     → embedder.embed(chunks.map(text)) → vectors[]
     → table.delete(`slug = '${slug}'`)        # 기존 청크 제거 (멱등성의 핵심)
     → table.add(chunks + vectors + 메타)
```

멱등 upsert: 같은 페이지를 두 번 색인해도 "삭제 후 재삽입"이라 중복이 없다.
→ **동기 주경로와 워처가 동시에 같은 페이지를 색인해도 결과가 동일**(경합 무해화).

### 6.2 검색 (`search(query: string, limit): SearchResult[]`)

```
query → embedder.embed([query])[0] → qvec
      → table.search(query, "hybrid").nearestTo(qvec).limit(k)   # FTS(query) + 벡터(qvec)
      → LanceDB RRFReranker(기본 k=60)가 두 랭킹 융합
      → [{ slug, title, text, score }]
```

정확한 하이브리드 API 호출 형태(`search` queryType vs `nearestTo().fullTextSearch()`)는
구현 시 `@lancedb/lancedb` 현행 버전에서 확정.

### 6.3 동기화 (위키 ↔ RAG)

**주경로 (동기, 결합은 포트로 약화):**

- WikiEngine 생성자에 **선택적** `PAGE_INDEXER` 포트 주입(`indexPage`/`removePage`).
- `publishPage`, 그리고 published 결과를 내는 `createPage`/`updatePage` 끝에서 `await indexer?.indexPage(page)`.
- 포트가 없으면 무동작 → **Part 1 테스트·기존 동작 그대로 통과**.
- draft 생성·수정은 색인하지 않음(색인 대상 = published).

**보조 경로 (워처, 비동기):**

- `WikiWatcher`가 `.md` 변경/삭제 감지 → 변경분만 `indexPage`/`removePage`.
- 사용자가 파일을 **직접 편집**하거나 주경로가 놓친 변경을 보정.

**전체 재색인 (시작 시):**

- `KnowledgeCoreModule.onModuleInit`이 `wiki.listPages({status:'published'})`를 받아
  `rag.reindexAll(pages)`로 넘긴다.
- → RagStore가 WikiEngine을 **역방향 의존하지 않음** → 순환 의존 회피.
  (WikiEngine → PAGE_INDEXER 포트 단방향만 존재.)

## 7. 에러·한계·동시성 (정직하게 짚는 부분)

- **모델 다운로드**: bge-m3 onnx 첫 다운로드(수백 MB~). 오프라인이면 명확한 에러로 실패시키고 안내.
  단위테스트는 FakeEmbedder라 영향 없음.
- **⚠️ 한국어 BM25 한계**: LanceDB 전문검색(Tantivy)은 한국어 형태소 분석을 하지 않는다(공백 분할).
  한국어 **키워드** 검색은 영어만큼 정밀하지 않고, **bge-m3 의미검색이 한국어를 주로 책임**진다.
  한국어 토크나이저는 Part 3 이월.
- **모델 리스크**: bge-m3의 transformers.js(onnx) 구동을 **구현 1번 태스크에서 실제 로딩 스파이크로 확정**.
  안 되면 동급 품질의 `multilingual-e5-large`(역시 1024차원)로 대체. `IEmbedder` 포트라 교체가 쉽다.
- **동시성**: LanceDB는 단일 라이터. 색인 쓰기를 RagStore 내부의 **간단한 직렬 큐**로 묶어
  동시 add/delete 경합을 피한다. 진짜 단일-라이터 락(위키+RAG 공통)은 Part 3 위임(이미 이월 목록).
- **워처 ↔ git**: 워처는 `.md`만 본다(`.git`·잠금파일 무시). WikiEngine이 쓰고→git 커밋하는
  중간 상태는 디바운스로 흡수. 멱등 색인이라 중복 트리거도 안전.

## 8. 테스트 전략 (TDD)

FakeEmbedder + 임시 디렉토리(LanceDB) 기반 단위테스트:

1. 색인 → 검색 왕복 (넣은 페이지가 검색됨)
2. 멱등성 (같은 페이지 2회 색인 → 청크 중복 없음)
3. `removePage` (삭제 후 검색 안 됨)
4. 청킹 경계 (헤딩/문단/긴 본문/빈 본문)
5. 하이브리드 융합 경로 (벡터·FTS 양쪽 결과가 RRF로 합쳐짐)
6. WikiEngine 연동 (publish 시 indexer 호출, indexer 없으면 무동작 — Part 1 테스트 회귀 없음)

- 실제 bge-m3 통합테스트 1개: 한·영 질의가 의미적으로 맞는 페이지를 찾는지.
  무겁고 다운로드 필요 → 환경변수(`ENGRAM_RAG_INTEGRATION=1`)로 opt-in, 기본 skip.
- 모든 spec은 temp 디렉토리를 `afterAll`로 정리(Part 1 패턴 계승).

## 9. 의존성 (추가)

- `@lancedb/lancedb` — 임베디드 벡터 저장소 + 하이브리드 검색
- `@huggingface/transformers` — 로컬 임베딩(transformers.js)
- `chokidar` — 파일 워처

dev 의존성 추가 없음(jest 기존).

## 10. 리스크와 완화

| 리스크 | 완화 |
|---|---|
| bge-m3가 transformers.js(onnx)에서 안 돎 | 구현 1번 태스크 스파이크로 조기 확인, e5-large 대체 |
| 모델 용량·첫 로딩 지연 | FakeEmbedder로 테스트 격리, 실모델은 1회 캐시 |
| 한국어 키워드 검색 약함 | 의미검색(벡터)이 1차 책임, 토크나이저는 Part 3 |
| LanceDB API 버전 변동 | 구현 시 context7로 현행 확인, 호출은 RagStore 내부에 격리 |
| 워처·주경로 동시 색인 경합 | 멱등 upsert + 내부 직렬 큐 |

## 11. 구현 시 확정할 것 (스파이크/태스크에서)

- bge-m3 onnx 모델의 정확한 HF repo ID와 transformers.js 로딩 코드
- `@lancedb/lancedb` 현행 하이브리드 검색 호출 형태(RRF 지정 방식)
- 청킹 파라미터(문자 상한·오버랩 유무) — 실제 위키 페이지 길이 보고 조정
- chokidar 디바운스 간격(윈도우 파일 잠금 고려)

## 12. Part 3 이월 (이 설계가 남기는 것)

- 단일-라이터 락: 위키 `commitAll` + RAG 쓰기 공통(설계 §10.3/§11)
- 한국어 BM25 토크나이저(lindera/nori 계열)
- 벡터 ANN 인덱스 튜닝(데이터 증가 시)
- 멀티유저 네임스페이싱
