# 위키 의미검색 앱 노출 설계

작성일: 2026-07-13
상태: 설계 확정(브레인스토밍 산출) — 구현 플랜 대기

---

## 0. 배경 — 왜 지금

지식 코어의 핵심은 **의미검색**(bge-m3 임베딩 + FTS 하이브리드, RRF 융합)이다. `RagStore.search`는 동작하며 CLI 데모(`npm run demo`)로 검증됐다. 그러나 **앱(렌더러)에는 이 검색이 노출돼 있지 않다** — WikiArea의 검색창은 이미 받아온 목록을 제목/카테고리 **글자 부분일치**로만 거를 뿐, 서버 의미검색 프레임(`wikiSearch`)이 없다. 파괴적 위키 행위까지 끝난 지금, "만들어 둔 검색 엔진을 사람 손에 쥐여주는" 자연스러운 다음 조각이다.

**핵심 결정.** WikiArea의 기존 필터 박스를 **검색창으로 승격**한다(방식 A). 비면 전체 목록 브라우즈(현행 유지), 타이핑하면 서버 의미검색. 검색은 읽기 전용이라 권한 게이트 없음. 코어(WikiEngine/RagStore) 로직은 무변경 — `PageIndexer` 포트에 `search`를 노출하고 얇은 위임 메서드만 더한다.

---

## 1. 확정된 모델 (사용자와 합의)

1. **방식 A(박스 통합)**: 기존 필터 박스 하나를 검색창으로 승격. `query` 비었을 때 = 전체 `pages` 브라우즈(현행 그대로), 차면 = 서버 의미검색 결과.
2. **트리거 = 타이핑 중 자동**(디바운스 300ms). 개인/팀 위키라 질의량이 적어 서버 부담 미미.
3. **점수 숨김**: RRF 융합 점수(≈0.03 같은 내부 수치)는 사용자에게 무의미 → UI에 안 보임. 순위 + 매칭 스니펫만.
4. **검색 = 게시(published) 페이지만**: 색인 대상이 published뿐이라 결과도 자연히 published만. 브라우즈(빈 검색창)는 draft 뱃지 포함 전체를 그대로 봄 — 이 비대칭은 의도(검색=확정 지식, 브라우즈=목록).
5. **권한 게이트 없음**: 읽기 프레임(wikiList/wikiGet과 동일). 무인증/brain 모드 통과.
6. **스코프 = defaultConnId 중앙 위키**(DEFAULT_USER) — wikiList와 동일 원칙.

---

## 2. 설계 — 백엔드

### 2.1 PageIndexer 포트 확장 (rag.types.ts)

`PageIndexer` 인터페이스에 `search`를 추가한다. `RagStore`는 이미 `search(query, limit?, userId?): Promise<SearchResult[]>`를 구현하므로 **포트만 넓히면 된다**(구현 무변경). `SearchResult = { userId?, slug, title, text, score }`(기존).

```ts
export interface PageIndexer {
  indexPage(page: IndexablePage): Promise<void>;
  removePage(slug: string, userId?: string): Promise<void>;
  reindexAll(pages: IndexablePage[]): Promise<void>;
  search(query: string, limit?: number, userId?: string): Promise<SearchResult[]>; // 신규
}
```

- 이 포트를 구현하는 다른 구현체(테스트 SpyIndexer 등)는 `search` 스텁을 추가해야 한다(빈 배열 반환).

### 2.2 WikiEngine.search (신규, 얇은 위임)

```ts
// 위키 의미검색(읽기). indexer 미주입(RAG 미탑재) 시 빈 배열.
async search(query: string, limit = 8, userId: string = DEFAULT_USER): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  return (await this.indexer?.search(q, limit, userId)) ?? [];
}
```

- 락 불필요(읽기 전용, 파일/커밋 없음).
- 빈/공백 쿼리 → 빈 배열(서버 왕복 없이 조기 반환).
- `limit` 기본 8(UI 표시 개수). indexer 없으면 `?? []`.

### 2.3 프로토콜 (shared/protocol.ts)

```ts
export interface WikiSearchHit { slug: string; title: string; snippet: string; score: number }
// ClientFrame +=
| { t: 'wikiSearch'; query: string }
// ServerFrame +=
| { t: 'wikiResults'; query: string; list: WikiSearchHit[] }
```

- `WikiSearchHit.snippet` = `SearchResult.text`(매칭된 청크 본문). `score`는 프레임엔 실어 보내되 **렌더러는 표시하지 않음**(향후 정렬/디버깅 여지 — 순위는 list 순서로 이미 보장). ponytail: score 필드는 list 순서로 이미 순위가 정해지므로 표시엔 불필요하나, 클라가 재정렬·디버깅할 여지로 실어 보낸다.
- 응답에 `query`를 **되돌려** 담는다 → 늦게 도착한 응답이 더 최신 검색어의 결과를 덮어쓰지 않게 하는 순서 가드(렌더러가 대조).

### 2.4 self.adapter — wikiSearch 프레임

`case 'wikiGet'` 옆에 추가. wikiList/wikiGet과 동일하게 **권한 게이트 없음**(읽기).

```ts
case 'wikiSearch': {
  if (!this.wikiDeps || typeof f.query !== 'string') return;
  const hits = await this.wikiDeps.wiki.search(f.query);
  const list = hits.map((h) => ({ slug: h.slug, title: h.title, snippet: h.text, score: h.score }));
  this.sendTo(ws, { t: 'wikiResults', query: f.query, list });
  return;
}
```

- 예외는 기존 handleFrame try/catch가 흡수(상주 불사).
- `wikiDeps` 미주입 시 no-op(현행 프레임 관례).

---

## 3. 설계 — 렌더러 (방식 A)

### 3.1 WikiArea

기존 pages 탭 왼쪽의 필터 `<input>`을 **검색창**으로 승격. 새 상태·props:

- Props 추가: `searchResults: WikiSearchHit[]`, `onSearch: (query: string) => void`.
- 내부 상태: 기존 `filter`(문자열)를 검색어로 재사용. **표시는 WikiArea가 자기 `filter` 상태로 자체 게이트**한다(App이 결과를 지우지 않아도 스테일 결과가 안 보이게):
  - **빈 문자열** → 현행 그대로 전체 `pages` 목록 렌더(브라우즈). `searchResults`는 쳐다보지 않음.
  - **비어있지 않음** → `searchResults`를 순위 순서로 렌더(제목 + 스니펫). 클릭 → `onOpenPage(slug)`(기존).
- 디바운스: `useEffect`가 `filter`를 300ms 디바운스해 `onSearch(query)` 호출. 빈 쿼리면 `onSearch` 호출 안 함(브라우즈 모드 — 자체 게이트가 브라우즈를 그림). cleanup으로 타이머 정리.
- 결과 행: 제목 + `snippet`(muted, 한 줄 말줄임). **score 미표시.** draft 뱃지·카테고리는 브라우즈 행에만(검색 결과는 published만이라 뱃지 불필요).
- 빈 결과(쿼리 있으나 `searchResults` 길이 0) → "결과 없음" 안내(i18n).
- placeholder를 검색 의미로 변경(예: "위키 검색…" / "Search wiki…").

### 3.2 App 배선

- 상태 추가: `wikiResults: WikiSearchHit[]`, `wikiQueryRef`(현재 검색어 — 에코 대조용).
- 프레임 핸들러(defaultConnId 스코프): `f.t === 'wikiResults'` → **되돌아온 `f.query`가 현재 검색어와 같을 때만** `setWikiResults(f.list)`(늦은 응답 무시). 다르면 버림.
- WikiArea에 `searchResults={wikiResults}`, `onSearch={(q) => { wikiQueryRef.current = q; send(defaultConnId, {t:'wikiSearch', query:q}); }}` 전달.
- App은 빈 검색어를 지우려 애쓸 필요 없음 — WikiArea가 자기 `filter`로 표시를 게이트하므로(§3.1) 브라우즈 모드에선 스테일 `wikiResults`가 애초에 안 보인다. 에코 대조(query≠ref면 무시)로 오래된 비-빈 쿼리 응답이 최신 결과를 덮어쓰는 것만 막으면 충분.

### 3.3 i18n

`wikiSearchPh`("위키 검색…"/"Search wiki…"), `wikiNoResults`("결과 없음"/"No results") 추가.

---

## 4. 에러 처리·하위호환

- **RAG 미탑재**(indexer 미주입): `WikiEngine.search`가 빈 배열 → 검색 결과 없음. 앱은 정상 동작(브라우즈는 됨). 회귀 없음.
- **무인증/brain 모드**: 게이트 없으므로 그대로 검색됨(읽기).
- **늦은/순서 뒤바뀐 응답**: query 에코 대조로 무시 → 항상 최신 검색어 결과만 표시.
- **기존 필터 동작**: 빈 검색창의 브라우즈는 현행과 동일(제목/카테고리 부분일치 필터는 **의미검색으로 대체**되므로, 부분일치 필터 기능은 사라지고 의미검색이 그 자리를 대신함 — 방식 A의 의도된 결과).
- **제안/승인·파괴적 행위 흐름**: 무변경. 검색은 완전 별개 읽기 경로.

---

## 5. 테스트 전략

- **RagStore**: 기존 `search` 테스트 유지(회귀 기준). 포트 확장은 타입만 — 런타임 무영향.
- **WikiEngine.search**: indexer 주입 시 위임(스파이가 받은 query·limit 확인)·결과 패스스루. indexer 미주입 시 빈 배열. 빈/공백 쿼리 → 빈 배열(indexer 미호출).
- **self.adapter**: `wikiSearch{query}` → `wikiResults{query, list}` 반환(스니펫 매핑·query 에코). 빈 wikiDeps → no-op. 무인증 통과(게이트 없음).
- **렌더러 WikiArea**: 빈 검색창 → 브라우즈 목록 렌더. 타이핑 → (디바운스 후) `onSearch` 호출. `searchResults` 주입 시 결과 행 렌더(제목·스니펫, score 미표시). 결과 클릭 → `onOpenPage`. 빈 결과 → "결과 없음".
- **App**: `wikiResults` 프레임에서 query 에코가 현재 검색어와 **같을 때만** 반영, 다르면 무시.
- 기존 스위트(백엔드·렌더러) 무변경 통과가 회귀 기준.

---

## 6. 파일 구조 (요약)

**백엔드**
- `src/knowledge-core/rag/rag.types.ts` — `PageIndexer`에 `search` 추가.
- `src/knowledge-core/wiki/wiki-engine.ts` — `search` 위임 메서드.
- `shared/protocol.ts` — `WikiSearchHit`·`wikiSearch`·`wikiResults`.
- `src/edge/messenger/self.adapter.ts` — `wikiSearch` 프레임 처리(게이트 없음).

**렌더러**
- `renderer/src/components/WikiArea.tsx` — 필터 박스를 검색창으로 승격(빈=브라우즈·타이핑=결과·디바운스).
- `renderer/src/App.tsx` — `wikiResults` 상태·프레임·에코 대조·onSearch 배선.
- `renderer/src/i18n.ts` — `wikiSearchPh`·`wikiNoResults`.

---

## 7. 이번에 안 하는 것 (되살릴 신호)

- **검색 필터(카테고리/상태/출처별 좁히기)** → 지금은 순수 의미검색. 필요 시 후속.
- **하이라이트**(스니펫 내 매칭어 강조) → 후속 UI.
- **draft/미색인 검색** → 색인 대상 확장은 별개 결정.
- **검색 히스토리·자동완성** → YAGNI, 신호 오면.
- **다중 유저 네임스페이스 검색** → 중앙 위키(DEFAULT_USER) 유지(15/16a 결정).
