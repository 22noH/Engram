# Phase 15c — 여러 두뇌 동시 쓰기 자동 병합 설계

작성일: 2026-07-11
상태: 설계 확정(브레인스토밍 산출) — 구현 플랜 대기

---

## 0. 이 문서의 위치 — 큰 그림 속 조각

Phase 15("여러 Engram 지식을 한 공간으로")의 마지막 조각:

| # | 조각 | 이번 |
|---|------|------|
| 15a | 클라 위키(읽기+승인함) | (완료) |
| 15b | 원격/중앙 저장(git 원격 동기화) | (완료) |
| **15c (이번)** | **여러 두뇌 동시 쓰기** | 같은 페이지 동시 편집 시 자동 병합(충돌 해결) |

15b는 같은 페이지 동시 편집 충돌을 **안전하게 회피**만 했다(pull 시 `git merge --abort` +
로컬 유지 + 경고 → 그 페이지는 수렴 못 하고 다음 주기에 또 충돌). 15c는 그 충돌을 **실제로
해결**해 양쪽 지식을 하나로 합친다.

**핵심 결정 — 하이브리드**: 흔한 경우(서로 다른 곳 추가·frontmatter 메타 차이)는 **결정론적
병합**(A), 진짜 같은 줄 겹침(드묾)만 **두뇌(LLM) 병합**(B), 두뇌 실패 시 **union 폴백**(손실 0).
15b의 abort는 최후 안전망으로 남긴다 — **sync 루프는 어떤 경우에도 안 깨진다.**

---

## 1. 문제와 관찰

위키 페이지 = frontmatter(YAML: title·category·status·sources·created·updated) + 마크다운 본문.

두 두뇌가 같은 페이지를 편집하면:
- **본문을 서로 다른 곳에 추가(append)** → git 3-way 병합이 **깨끗이 합침**(흔함 — 제안은 추가형).
- **frontmatter는 거의 항상 충돌** — 양쪽이 `updated`를 다른 시각으로 바꾸므로. 하지만 이는
  규칙으로 결정론적 조정 가능(updated=최신 등).
- **본문 같은 줄을 양쪽이 다르게 수정** → 진짜 충돌(드묾 중의 드묾). 여기만 지능적 병합이 값어치.

그래서 15c = **frontmatter 규칙 조정 + 본문 3-way(대부분 깨끗) + 진짜 본문 겹침만 두뇌/union.**

---

## 2. 설계

### 2.1 순수 병합 로직 (`page-merge.ts`, 신규)

```ts
// base가 없을 수 있음(add/add·무관 히스토리) → undefined.
export function reconcileFrontmatter(
  base: PageFrontmatter | undefined, ours: PageFrontmatter, theirs: PageFrontmatter,
): PageFrontmatter;

export function unionBodies(oursBody: string, theirsBody: string): string;
```

- `reconcileFrontmatter` 규칙(결정론):
  - `updated` = max(ours, theirs) (ISO 문자열 비교).
  - `created` = min(ours, theirs).
  - `sources` = ours ∪ theirs (순서 보존 dedup) — **무손실**.
  - `status` = 둘 중 하나라도 `published`면 `published`(지식 가시성 유지), 아니면 `draft`.
  - `title`/`category` = `updated`가 더 최신인 쪽(동률이면 ours). 드문 동시 제목변경은 최신 우선.
- `unionBodies` = ours가 theirs와 다르면 둘을 구분자로 이어붙임(양쪽 다 보존, 폴백용).
  같으면 하나만.

순수 함수 → 단위 테스트로 규칙 고정.

### 2.2 WikiGit 충돌 해결 (`wiki-git.ts` — `pull` 확장)

15b의 `pull`은 충돌 감지(`status.conflicted`) 시 abort했다. 15c는 **해결**을 먼저 시도:

- **본문 병합기 주입**: `private bodyMerger?: (oursBody: string, theirsBody: string) => Promise<string | null>`
  + `setBodyMerger(fn)`. 미설정/`null` 반환 → union 폴백.
- 충돌 시(pull의 merge 후 `status.conflicted.length > 0`) `resolveConflicts()`:
  - 각 충돌 `.md` 경로마다:
    - 세 버전을 인덱스 스테이지에서 꺼냄: `git show :1:<path>`(base)·`:2:<path>`(ours)·`:3:<path>`(theirs).
      base 스테이지 없으면(add/add) `base = undefined`.
    - 각각 `parsePage`로 WikiPage 파싱.
    - `frontmatter = reconcileFrontmatter(base?.frontmatter, ours.frontmatter, theirs.frontmatter)`.
    - **본문 3-way**: `git merge-file`로 base·ours·theirs **본문 텍스트**만 병합
      (임시 파일 3개 → `git merge-file -p <ours> <base> <theirs>` → stdout + exit code):
      - exit 0(깨끗) → 병합 본문.
      - exit>0(진짜 겹침) → `bodyMerger(oursBody, theirsBody)` 시도 → 비지 않으면 그 결과,
        아니면 `unionBodies(...)`.
    - 합친 `{slug, frontmatter, body}` → `serializePage` → 파일 쓰기 → `git add <path>`.
  - 전부 스테이징 후 `git commit -m "merge: reconcile <slugs>"` → `{ok:true, conflict:false}`(해결됨).
  - **resolveConflicts가 예외를 던지면** → `git merge --abort` + `{ok:true, conflict:true}`(15b 폴백).
- push는 15b 그대로(해결 커밋을 원격에 보냄; 거부 시 pull+재시도 — 이제 pull이 해결까지 함).

**저장소 전역 뮤텍스(15b)** 안에서 실행되므로 동시 쓰기와 인터리브하지 않는다. 합친 파일은
WikiWatcher가 자동 재색인.

### 2.3 두뇌 병합 배선 (`main.ts`)

- `app.get(BRAIN)`(기본 두뇌)로 `bodyMerger`를 만들어 `wikiGit.setBodyMerger(...)`:
  ```ts
  const bodyMerger = async (oursBody, theirsBody) => {
    const r = await brain.complete(buildMergePrompt(oursBody, theirsBody));
    const t = r.isError ? '' : r.text.trim();
    return t ? t : null; // 실패/빈 출력 → null → union 폴백
  };
  ```
- 병합 프롬프트: "다음은 한 위키 페이지 본문의 두 버전이다. **어느 사실도 빠뜨리지 말고** 하나로
  합쳐라. 마크다운만 출력." (`prompts/wiki-merge.md`로 외부화, personas/ 관례).
- 위키 원격 동기화가 켜졌을 때만 설정(원격 없으면 병합 자체가 안 일어남).

**검증 한계(정직)**: 두뇌가 "한 글자도 안 빠뜨렸는지"는 자동 검증 불가(정상 dedup으로 짧아질 수
있어 길이로도 못 잡음). 그래서 두뇌 병합은 **드문 진짜-겹침 케이스의 미화**이고, union이 항상
안전망(무손실)이다. 비-error·비지 않은 출력만 수용, 그 외 union.

---

## 3. 문서 (README)

"위키 중앙 저장(Phase 15b)"의 충돌 경고를 갱신:
- 이제 같은 페이지 동시 편집도 **자동 병합**한다: frontmatter는 규칙 조정(최신 시각·출처 합집합·
  published 우선), 본문은 3-way 병합(서로 다른 곳 추가는 깨끗이), 같은 줄 진짜 겹침만 두뇌가
  합치고 실패 시 양쪽 다 보존(union).
- 두뇌 병합은 기본 두뇌를 쓴다. 두뇌가 없거나 실패해도 union으로 안전 병합 → sync는 안 깨진다.

---

## 4. 테스트

**순수(`page-merge.spec`):**
- `reconcileFrontmatter`: updated=max·created=min·sources=합집합dedup·status=published우선·
  title/category=최신쪽·base undefined 처리.
- `unionBodies`: 다르면 둘 보존, 같으면 하나.

**WikiGit 충돌 해결(`wiki-git-remote.spec` 확장, bare repo + 두 클론):**
- 같은 페이지 본문 **다른 곳 추가** + frontmatter 다름 → pull이 **깨끗 병합**(양쪽 append 다 있음,
  frontmatter 조정) + 커밋 + push, 상대가 pull하면 합쳐진 페이지 수신. `conflict:false`.
- 같은 줄 **진짜 겹침** + bodyMerger 미주입 → **union**(양쪽 내용 다 존재), `conflict:false`.
- 같은 줄 겹침 + **fake bodyMerger**(고정 문자열 반환) → 그 출력이 병합 결과에.
- fake bodyMerger가 `null` 반환(두뇌 실패 모사) → union 폴백.
- 두 두뇌 수렴: A 해결·push → B pull → 같은 합쳐진 페이지.

**두뇌 병합기(단위, 선택):** fake BrainProvider(isError/빈출력)로 null 반환 → union 경로 확인.

---

## 5. 파일 영향 요약

| 파일 | 변경 |
|------|------|
| `src/knowledge-core/wiki/page-merge.ts` | (신규) reconcileFrontmatter·unionBodies 순수 |
| `src/knowledge-core/wiki/wiki-git.ts` | pull 충돌 시 resolveConflicts(3-way+두뇌/union) + `setBodyMerger` |
| `src/main.ts` | 기본 두뇌 → bodyMerger 배선(원격 동기화 켜졌을 때) |
| `prompts/wiki-merge.md` | (신규) 병합 프롬프트 |
| `README.md` | 자동 병합 안내 |

WikiEngine·WikiWatcher·RagStore·WikiSyncService·클라이언트 무변경(pull 내부만 확장).

---

## 6. YAGNI로 자른 것 (되살릴 신호)

- **분산 락(동시 편집 원천 방지)** → 불필요. 자동 병합이 무손실로 수렴시킴.
- **CRDT/실시간 공동편집** → 60s 주기 동기의 위키엔 과함.
- **두뇌 병합 결과 무손실 자동 검증** → 불가(근본적). union이 안전망.
- **frontmatter title/category 3-way 병합** → 최신-쪽 규칙으로 충분(sources만 합집합=무손실 핵심).
- **union 결과를 두뇌가 나중에 정리(미화)** → 별도·선택 후속(digest/ambient가 평소 위키 정리).
