# Phase 15b — 위키 git 원격 동기화 (중앙 저장) 설계

작성일: 2026-07-10
상태: 설계 확정(브레인스토밍 산출) — 구현 플랜 대기

---

## 0. 이 문서의 위치 — 큰 그림 속 조각

Phase 15("여러 Engram 지식을 한 공간으로")를 3조각으로 분해했다:

| # | 조각 | 이번 |
|---|------|------|
| 15a | 클라이언트 위키(읽기+승인함) | (완료) |
| **15b (이번)** | **원격/중앙 저장** | 위키를 중앙 git 원격에 push/pull로 모은다 |
| 15c | 여러 두뇌 동시 쓰기 | 같은 페이지 동시 편집 병합·분산 락 |

**사용자 비전**: 각자 로컬에 두뇌를 굴려도 지식은 **하나의 중앙 위키에 모은다.** 위키는
이미 텍스트(.md) + git 버전관리(WikiGit)이므로, 그 위에 **git 원격 push/pull**만 얹으면
분산된 로컬 두뇌들이 하나의 중앙 저장소를 공유한다(git이 원래 그 용도).

**포맷 = 마크다운 유지**(HTML 전환 검토했으나 기각: HTML도 그림을 담지 않고[참조만],
RAG 의미검색·LLM 저작에 불리. 예쁜 표시는 클라 렌더가 담당). **바이너리(PDF·그림) 첨부
저장은 비범위**(별도 기능, Git LFS 고려). 위키 = 텍스트 지식.

**전송 = git 원격(NAS 마운트 아님)**: 위키 git을 네트워크 드라이브(SMB)에 두면 `.git`
손상·락 문제로 불안정. 로컬 git(빠르고 안정) + 원격 push/pull이 인터넷도 넘고 병합·백업도
공짜. 중앙 원격은 GitHub/사내 git/**자기 서버·NAS의 bare git 저장소** 무엇이든 가능.

---

## 1. 개념 — 로컬 커밋 + 주기 동기화

각 두뇌는 위키 로컬 git 저장소(`runtime/wiki`)를 **그대로** 유지한다(WikiEngine의 페이지별
락·경로-스코프 커밋 무변경). 그 위에서:

- **동기화 서비스**가 주기적으로 중앙 원격에 **pull(남의 지식 받기) → push(내 커밋 보내기)**.
- pull로 들어온 .md 변경은 **기존 WikiWatcher가 감지해 자동 재색인**(RAG 반영). 추가 코드 없음.
- git 저장소는 **위키 폴더만**(`runtime/wiki`) — RAG(`runtime/rag`)·상태·채팅은 각 두뇌 로컬
  (동기화 대상 아님). 텍스트 지식만 중앙화, 파생 색인은 로컬 캐시.
- **원격 미설정 → 동기화 안 함**(현행 로컬 전용 그대로, 하위호환).

---

## 2. 서버 설계

### 2.1 원격 설정 (`wiki-remote.config.ts`, 신규)

```ts
export interface WikiRemoteConfig {
  remote: string;          // git 원격 URL(빈 문자열/미설정 = 동기화 안 함)
  branch: string;          // 기본 'main'
  syncIntervalSec: number; // 기본 60
}
```

- `config/wiki-remote.json` 로드 + env `ENGRAM_WIKI_REMOTE`(URL) 오버라이드(기존 config
  로더 관례). `remote`가 비면 `null` 반환(동기화 비활성).
- 자격증명(SSH 키·토큰)은 여기 담지 않는다 — git 표준 인증(사용자 셋업). URL에 토큰을 넣는
  경우는 사용자 책임(README 안내).

### 2.2 WikiGit 원격 메서드 (`wiki-git.ts` 확장)

기존 `ensureRepo`/`commitAll`(로컬)은 무변경. 원격 메서드 추가:

- **`ensureRemote(url, branch)`**: `ensureRepo` 후 `origin` 원격을 추가/갱신(URL 바뀌면
  `remote set-url`). 최초 동기: 원격에 브랜치가 있으면 `pull`(로컬이 비어 있으면 사실상
  받아옴), 없으면 로컬을 `push -u origin <branch>`. 빈 저장소·최초 커밋 없는 엣지 처리.
- **`pull(branch)`**: `git pull --no-rebase origin <branch>`. **병합 충돌 시 → `git merge
  --abort` + 로컬 유지 + `{ conflict: true }` 반환**(경고 로그). 충돌 아닌 자동병합은 그대로.
- **`push(branch)`**: `git push origin <branch>`. **거부(non-fast-forward=원격이 앞섬)면 →
  `pull` 후 1회 재시도.** 그래도 실패면 다음 주기로 미룸(throw 안 함, 상태 반환).

모두 실패해도 예외를 **던지지 않고 상태로 반환**(상주 불사 — 호출자가 로그).

### 2.3 동기화 서비스 (`wiki-sync.service.ts`, 신규 — plain)

`ScheduleService` 패턴(DI 밖 plain, `main.ts` 배선). WikiGit + WikiRemoteConfig 주입.

- **`start()`**: `ensureRemote` → 최초 1회 `syncOnce()` → `setInterval(syncIntervalSec)`로
  반복 `syncOnce()`. `stop()`에서 인터벌 정리.
- **`syncOnce()`**: `pull()` → `push()`. 각 단계 에러/충돌은 로그만(상주 불사). pull 성공 시
  WikiWatcher가 재색인(자동).
- main.ts는 **원격이 설정됐을 때만** SyncService를 만들어 start. 미설정이면 미가동.

### 2.4 동시성(다중 두뇌)

- **동시 push**: git이 non-fast-forward로 거부 → `push`가 pull+재시도 → 커밋 레벨에서 대부분
  수렴.
- **같은 페이지 동시 편집 병합 충돌**: `pull`이 abort+로컬유지+경고. **진짜 충돌 해결(자동
  머지 전략·분산 락)은 15c.** 15b는 충돌을 안전하게 회피(손상 없음)까지.
- 위키는 페이지별·추가형(제안 append)이라 겹침 충돌은 드묾. 서로 다른 페이지 변경은 git이
  자동병합.

---

## 3. 문서 (README)

"위키" 안내에 중앙 저장 추가:
- `config/wiki-remote.json` `{ "remote": "git@...", "branch": "main", "syncIntervalSec": 60 }`
  또는 env `ENGRAM_WIKI_REMOTE`. 미설정이면 로컬 전용.
- 중앙 원격 = GitHub 비공개 저장소 / 사내 git / **자기 서버·NAS의 bare git**(`git init --bare`).
- 인증은 git 표준(SSH 키 권장, 또는 토큰). Engram은 자격증명을 관리하지 않는다.
- 여러 두뇌가 같은 원격을 공유하면 지식이 한 곳에 모인다. pull한 지식은 각 두뇌 RAG에 자동
  재색인. **같은 페이지 동시 편집 충돌 시 자동 해결은 다음 단계(15c)** — 그전까지는 충돌 시
  로컬 유지 + 경고.

---

## 4. 테스트

**로컬 bare git 저장소를 "원격"으로** 써서 실제 git 검증(네트워크 없이 결정적):

**WikiRemoteConfig(spec):**
- `wiki-remote.json` 로드 / env `ENGRAM_WIKI_REMOTE` 오버라이드 / remote 빈 값 → null.

**WikiGit 원격(spec, temp bare repo):**
- `ensureRemote` 최초: 로컬 커밋 → push → 다른 클론이 clone 시 그 페이지 보임.
- `push`: 두 번째 클론이 커밋·push → 첫 클론 `pull` → 그 페이지 받아옴.
- `push` 거부→재시도: 원격이 앞선 상태에서 push → pull+재시도로 성공.
- `pull` 충돌: 양쪽이 같은 파일 다르게 커밋 → pull → abort + 로컬 유지 + `{conflict:true}`.

**WikiSyncService(spec):**
- `syncOnce()`가 pull+push 호출(fake WikiGit 스파이) · 에러 시 throw 안 함.
- `start()`가 ensureRemote + 인터벌 등록, `stop()`이 정리.

**재색인(통합, 선택):** pull이 새 .md를 쓰면 WikiWatcher가 재색인(기존 WikiWatcher 테스트로
커버 — 파일 변경→색인). 별도 통합 스모크는 수동.

---

## 5. 파일 영향 요약

| 파일 | 변경 |
|------|------|
| `src/knowledge-core/wiki/wiki-remote.config.ts` | (신규) 원격 설정 로드 |
| `src/knowledge-core/wiki/wiki-git.ts` | `ensureRemote`/`pull`/`push` 추가(로컬 메서드 무변경) |
| `src/edge/wiki-sync.service.ts` | (신규) 주기 pull+push, plain·main 배선 |
| `src/main.ts` | 원격 설정 시 WikiSyncService 생성·start |
| `README.md` | 중앙 저장 설정·인증 안내 |

WikiEngine·WikiWatcher·RagStore·클라이언트 무변경(위키 로컬 동작·재색인 그대로).

---

## 6. YAGNI로 자른 것 (되살릴 신호)

- **같은 페이지 동시 편집 자동 병합·분산 락** → 15c. 15b는 충돌 안전 회피(abort+로컬유지)까지.
- **바이너리(PDF·그림) 첨부 저장(Git LFS)** → 별도 기능. 위키=텍스트 지식.
- **자격증명 관리(키 저장·회전)** → git 표준 인증에 위임(사용자 셋업).
- **NAS 마운트 방식** → git 원격 채택(네트워크-드라이브 git 불안정).
- **클라 동기화 상태 표시(마지막 동기·충돌 배지)** → 후속 UI. 15b는 백엔드 배관.
- **실시간(즉시) 전파** → 주기 동기(기본 60s)로 충분(지식 위키는 준실시간 OK).
