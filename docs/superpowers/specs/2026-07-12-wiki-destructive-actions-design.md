# 파괴적 위키 행위(내림·수정·하드삭제) 설계

작성일: 2026-07-12
상태: 설계 확정(브레인스토밍 산출) — 구현 플랜 대기

---

## 0. 배경 — 왜 지금

15a에서 위키는 **"추가만, 하드삭제·수동편집 없음"**을 안전을 위해 의도적으로 택했고, 두뇌
제안→사람 승인만이 위키를 채우는 길이었다. 16b(권한) §7이 이 파괴적 행위들을 "권한 모델 위에
얹을 후속 스펙"으로 미뤄뒀다. 이 스펙이 그 후속이다.

**핵심 결정.** 세 행위(내림·수정·하드삭제)를 **사람의 직접 조작**으로 열되, 각각 16b 세분
권한으로 게이트한다. 하드삭제는 여러 두뇌가 공유하는 위키에서 **"삭제가 이김"**(git rm 전파,
동시 수정 시 삭제 우선)으로 동기화한다.

**★코어 변경 예외.** 지금까지 Phase들은 "두뇌 코어(knowledge-core) 무변경"을 지켰으나, 파괴적
위키 조작은 본질적으로 WikiEngine과 WikiGit 병합 로직(둘 다 코어)을 건드린다. 불가피하며, 기존
add/append 병합 경로는 깨지 않고 delete 처리만 더한다.

---

## 1. 확정된 모델·권한 (사용자와 합의)

1. 세 행위 모두 **게시된 위키 페이지**(WikiArea 페이지 목록 항목)에 대한 사람의 직접 조작.
2. **권한 키 3개**(16b `permissions.ts`에 추가): `wiki.unpublish`·`wiki.edit`·`wiki.delete`.
   owner 전권. 무인증/brain 모드는 게이트 미적용(현행 보존).
3. **되돌림**: unpublish는 draft로 되돌려 재게시 가능. edit·delete는 git 이력에 남아 파일 복구는
   가능하나 앱 UI로는 되돌림 없음.
4. 두뇌 제안→승인 흐름과 **별개**(사람 직접). 제안 시스템(ProposalStore/Applier)은 무변경.
5. **하드삭제 동기화 = "삭제가 이김"**: 공유 위키에서 한 두뇌가 삭제하면 다른 두뇌에서도 지워짐.
   그 사이 다른 두뇌의 동시 수정은 잃을 수 있으나 git 이력에 남는다. 단일 두뇌(원격 미설정)면
   이 경로는 안 탐 — 그냥 로컬 삭제.

---

## 2. 설계 — WikiEngine (권위)

기존 `wiki-engine.ts`. 세 메서드 모두 `KeyedLock`(키 `${userId}/${slug}`)으로 read-modify-write
원자성 보장. userId 기본값 `DEFAULT_USER`(중앙 공유 위키 — 15/16a 결정).

- **`unpublishPage(slug, userId?)`** — 이미 존재. published→draft, 색인 제거, 이미 draft면 멱등
  no-op. 재사용만(무변경).
- **`editPage(slug, body, userId?)`(신규)** — 게시된 페이지 본문을 직접 교체.
  - 없는 페이지 → throw(호출자가 무시). frontmatter는 `updated`만 현재 시각으로 갱신(status·title·
    category·sources 등 유지). 파일 쓰기 → `git.commitAll('edit …', relPath)` → `indexer.indexPage`.
  - 반환: 갱신된 `WikiPage`.
- **`deletePage(slug, userId?)`(신규)** — 파일 하드삭제.
  - 없는 페이지 → 멱등 no-op(반환 false 등). 있으면 `git rm`(또는 fs.unlink + `git.commitAll`으로
    삭제 스테이징) → `indexer.removePage(slug, userId)` → 커밋. 반환: 삭제 여부.
  - WikiGit에 파일 삭제를 스테이징·커밋하는 경로가 필요(현 `commitAll`은 경로-스코프 커밋 —
    삭제도 `git add -A <path>`/`git rm`로 스테이징되면 커밋됨). 구현 시 삭제가 커밋에 포함되는지 확인.

## 2.1 설계 — WikiGit "삭제가 이김" (핵심·가장 위험)

15c의 `WikiGit.resolveConflicts`/`resolveOnePage`는 지금 **내용 충돌만** 병합한다
(스테이지 2=ours·3=theirs가 모두 존재하는 modify/modify). **delete/modify 충돌**(한쪽이 파일을
삭제 → 그쪽 스테이지가 없음)은 현재 `resolveOnePage`가 `oursRaw==null || theirsRaw==null`에서
throw → 상위 catch가 `merge --abort`(15b 안전 폴백)로 처리 → 삭제가 반영 안 되고 다음 주기 재충돌.

**변경**: `resolveOnePage`에서 스테이지 2 또는 3이 `null`(= 한쪽 삭제)이면 **삭제를 택함**:
`git rm --force <rel>`로 삭제를 스테이징하고 리턴(내용 병합 안 함). 양쪽 다 삭제면 이미 충돌
아님(정상 병합). 이로써 "삭제가 이김"이 성립하고, modify/modify 기존 경로는 그대로.

- 단일 두뇌(원격 미설정)면 `resolveConflicts` 자체가 안 불림 — 무영향.
- delete/modify가 아닌 진짜 내용 충돌은 15c 로직(두뇌/union) 그대로.

---

## 3. 설계 — ws 프레임 (self.adapter)

기존 wiki 프레임(wikiList/wikiGet/proposal…) 옆에 세 프레임 추가. 게이트는 16b `allowed(ws, perm)`
재사용(authDeps 없으면 통과·무권한 조용히 무시). `wikiDeps` 주입 시에만 처리.

- `wikiUnpublish{ slug }` → `allowed(ws,'wiki.unpublish')` 통과 시 `wiki.unpublishPage(slug)` →
  `broadcast({t:'wikiChanged'})`.
- `wikiEdit{ slug, body }` → `allowed(ws,'wiki.edit')` 통과 시 `wiki.editPage(slug, body)` →
  `broadcast({t:'wikiChanged'})`.
- `wikiDelete{ slug }` → `allowed(ws,'wiki.delete')` 통과 시 `wiki.deletePage(slug)` →
  `broadcast({t:'wikiChanged'})`.
- 모두 예외는 기존 handleFrame try/catch가 흡수(상주 불사).

protocol: `ClientFrame`에 세 프레임 추가.

## 3.1 권한 키 등록 (16b permissions.ts)

- `PERMISSIONS`에 `'wiki.unpublish'`·`'wiki.edit'`·`'wiki.delete'` 추가(총 5키). `Permission` 타입 확장.
- AdminArea 체크박스는 `PERMISSIONS` 파생이 아니라 현재 고정 2키 배열(`PERM_KEYS`)이므로 §4에서
  5키로 확장(라벨 i18n 추가).

---

## 4. 설계 — 클라이언트

- **권한 인지**: authOk가 이미 permissions 전달(16b). 클라 `allow(me, 'wiki.edit')` 등으로 버튼 게이트.
- **WikiArea 페이지 열람 화면**에 행위 버튼(권한 있을 때만):
  - **Unpublish**: 버튼 → `wikiUnpublish{slug}`.
  - **Edit**: 버튼 → 본문 마크다운 `textarea` 인라인 편집기(현재 렌더된 본문을 편집) → 저장 시
    `wikiEdit{slug, body}`, 취소 시 편집 종료.
  - **Delete**: 버튼 → `window.confirm`(되돌릴 수 없음 경고) → `wikiDelete{slug}`.
  - 처리 후 `wikiChanged` 브로드캐스트로 목록·열람이 갱신됨(기존 15a 경로).
- **AdminArea**: 권한 체크박스가 5키로(기존 2 + 신규 3). i18n 라벨 3개 추가.
- 이중 방어: 서버 게이트(권위) + 클라 버튼 숨김(UX).

---

## 5. 에러 처리·하위호환

- **무권한**: 서버 조용히 무시(프레임 관례). 클라는 버튼 미표시.
- **무인증/brain 모드**: `allowed`가 true(게이트 미적용) — 현행 보존.
- **제안/승인 흐름**: 무변경. 이 행위들은 별개 경로.
- **기존 위키 병합**(add/append modify/modify)**: WikiGit 변경은 delete/modify 분기 추가뿐 —
  기존 내용 병합 경로 회귀 없음(테스트로 고정).
- **삭제 후 색인**: `removePage`로 RAG 색인에서 제거(stale 검색결과 방지).

---

## 6. 테스트 전략

- **WikiEngine**:
  - `editPage`: 본문 교체·`updated` 갱신·status published 유지·`indexPage` 호출. 없는 페이지 throw.
  - `deletePage`: 파일 제거·`removePage` 호출·커밋. 없는 페이지 멱등 no-op.
  - `unpublishPage`: 기존 테스트 유지.
- **WikiGit `resolveOnePage`**: delete/modify(스테이지 2 또는 3 null) → `git rm` 삭제 택함(삭제가 이김).
  modify/modify는 기존대로 병합(회귀). 실 bare 원격 동시 삭제/수정 통합 테스트(가능 범위).
- **self.adapter**: 세 프레임 권한 게이트(무권한 무시·권한자 통과·무인증 통과)·wikiChanged 브로드캐스트.
- **permissions.ts**: 5키·`can`/`sanitize`가 신규 키 수용.
- **렌더러**: WikiArea 버튼 노출 조건(allow)·편집기 저장→wikiEdit·삭제 확인→wikiDelete·AdminArea 5키.
- 기존 스위트 무변경 통과가 회귀 기준.

---

## 7. 파일 구조 (요약)

**백엔드**
- `src/knowledge-core/wiki/wiki-engine.ts` — `editPage`·`deletePage`(unpublishPage 재사용).
- `src/knowledge-core/wiki/wiki-git.ts` — `resolveOnePage` delete/modify→git rm(삭제가 이김).
  삭제 커밋 경로 확인(`commitAll`/`git rm`).
- `src/edge/auth/permissions.ts` — `PERMISSIONS`에 3키 추가.
- `shared/protocol.ts` — `wikiUnpublish`·`wikiEdit`·`wikiDelete` ClientFrame.
- `src/edge/messenger/self.adapter.ts` — 세 프레임 처리(allowed 게이트 + wikiChanged).

**렌더러**
- `renderer/src/components/WikiArea.tsx` — 행위 버튼·인라인 편집기·삭제 확인(allow 게이트).
- `renderer/src/components/AdminArea.tsx` — PERM_KEYS 5키.
- `renderer/src/App.tsx` — WikiArea에 canUnpublish/canEdit/canDelete + 콜백(defaultConnId 스코프).
- `renderer/src/i18n.ts` — 문구.

---

## 8. 이번에 안 하는 것 (되살릴 신호)

- **앱 UI 되돌림(undo)·휴지통** → git 이력이 복구원. 필요 시 후속.
- **삭제 시 승인 절차**(2인 승인 등) → 권한 게이트로 충분. 규제 요구 시.
- **draft 페이지 편집/삭제** → 이 스펙은 게시된 페이지 대상. draft는 제안 흐름의 산물.
- **버전 히스토리 열람 UI** → git log 노출은 별도.
- **삭제 알림/감사 로그** → 필요 시.
