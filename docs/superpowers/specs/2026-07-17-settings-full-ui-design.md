# 설정 전면 UI화 — 설계

날짜: 2026-07-17
상태: 승인됨 (브레인스토밍 완료 — 목업 확정)

## 1. 문제

설정 상당수가 JSON 파일 편집 전용이다: 두뇌 세부(brains.json 프로필 필드), 권한 상세
(permissions.json — commandMode만 UI 있음), 코딩 프로젝트(coderepos.json), 예약
(schedules.json), 위키 원격(wiki-remote.json). DESIGN 로드맵의 "설정 전면 UI화" 페이즈.
직전 "올라마 다중 두뇌 등록" 스펙 §5가 이월한 두뇌 전면 관리(편집·이름변경)도 여기서
흡수한다.

## 2. 목표 / 비목표

목표 (사용자 결정: 다섯 덩어리 전부 한 페이즈):
1. 설정창을 **사이드바 네비게이션**으로 개편 — Status · Brain · Coding · Code repos ·
   Schedules · Wiki sync · Discord · Advanced. 클릭 시 해당 섹션만 표시.
2. **Brain**: 등록 목록 각 줄에 Edit — 인라인 패널에서 이름(=이름변경)·model·baseUrl·
   API key(마스킹)·maxTokens·단가 2종·search provider·search API key 편집.
3. **Coding**: 기존 commandMode 셀렉트 아래 권한 상세 — writePaths·denyPaths·
   command allowlist를 칩(태그) UI로 추가/삭제.
4. **Code repos**: 별칭↔경로 표(추가는 Browse=기존 `engram:pick-folder` 재사용) +
   searchRoots 칩.
5. **Schedules**: 목록(cron·task·channelId·once 표시)+삭제만. 생성·수정은 채팅
   (사용자 결정 — 채널 맥락이 채팅에 있음). "새 예약은 채팅에서" 안내 문구.
6. **Wiki sync**: remote·branch·syncIntervalSec 폼. remote 비우면 로컬 전용.

비목표:
- 설정창 React 재작성(접근 B 기각 — 순수 HTML+인라인 JS 유지), 채팅 앱으로 이동(접근 C).
- permissions.json의 persona별 `allow.tools` 맵 UI — 페르소나×도구 매트릭스는 니치
  고급 설정이라 JSON 유지(Advanced 안내 문구에 이미 포함). 필요 신호 오면 후속.
- 예약 생성/수정 UI, 채널 이름 해석(channelId raw 표시).
- 서버(src/agent-layer·brain·edge·knowledge-core) 로직 변경 없음 — 전부 파일
  읽기/쓰기와 표시. 기존 "재시작하면 적용" 패턴 유지(핫리로드 안 만듦).

## 3. 설계

### 3.1 공통 원칙 (전 섹션)

- 패턴은 다중 두뇌 등록 작업과 동일: **desktop 순수 함수(테스트) → IPC(얇은 위임) →
  preload → settings.html 폼**. 저장 후 "Restart to apply" 힌트.
- 렌더러 문자열은 전부 textContent/createTextNode (innerHTML 금지 — 기존 규칙).
- i18n: 영어 기본 + ko, 기존 `t` 객체 확장.
- 각 config 함수는 깨진/없는 파일 fault-tolerant(기존 결) + **부분 갱신**(다른 필드 보존).

### 3.2 사이드바 (settings.html 골격)

- `<nav>`(좌, 고정폭 ~150px) + 콘텐츠 영역. nav 버튼 클릭 → 해당 `<section>`만 표시
  (나머지 `hidden` — `[hidden]{display:none!important}` 이미 있음). 기본 선택 Status.
- 기존 섹션(Status·Brain·Coding·Discord·Advanced)은 내용 무변경 이사. 창 최소 크기
  상향(사이드바+폼 감안, main.ts BrowserWindow 옵션).
- 프레임워크·라이브러리 추가 없음.

### 3.3 Brain 편집 (brains-file.ts 확장)

- `listBrainDetails(configDir)`: 편집 폼용 전 필드 반환 — key·provider·model·baseUrl·
  maxTokens·inputUsdPerMTok·outputUsdPerMTok·searchProvider·isDefault + **hasApiKey/
  hasSearchApiKey(boolean)**. ★API 키 원문은 렌더러로 보내지 않는다(마스킹이 아니라
  미전송). 기존 `listBrains`는 그대로 두고 별도 함수(드롭다운은 가볍게 유지).
- `updateBrainProfile(configDir, key, patch, newKey?)`: 프로필 부분 갱신(정의된 필드만
  덮어씀 — apiKey/searchApiKey는 patch에 비어 있으면 기존 값 보존). `newKey`가 오면
  이름변경: newKey로 이동 + 옛 key 삭제 + **default가 옛 key를 가리켰으면 default도
  이동**(removeBrainProfile의 default 가드에 안 걸리는 단일 원자 함수로 구현).
  newKey가 이미 존재하면 no-op 반환 false(UI에서 이름 충돌 안내) — 조용한 덮어쓰기 금지.
- 숫자 필드는 유한 양수만 채택(brain.config의 posIntEnv 결), 빈 입력 = 필드 제거(기본값
  복귀).
- UI: 등록 목록 각 줄 Edit → 줄 아래 인라인 패널(목업 확정 모양, 2열 grid). Save 시
  updateBrainProfile → 목록·드롭다운 갱신. Cancel로 닫기. Delete·추가·default
  드롭다운은 기존 그대로.

### 3.4 Coding 권한 상세 (permissions-file.ts 확장)

- `getPermissionDetails(configDir)`: `{ writePaths: string[], denyPaths: string[],
  commands: string[] | null }` (commands null = 미지정 → 내장 DEFAULT_COMMANDS 사용 중).
- `setPermissionList(configDir, field, values)`: field ∈ 'writePaths'|'denyPaths'|
  'commands' 부분 갱신. commands는 빈 배열과 미지정(null=필드 삭제)을 구분 —
  빈 배열=전부 거부, 미지정=내장 기본. UI에는 "비우면 내장 기본목록 사용" 안내와
  "기본값으로 되돌리기" 버튼(=필드 삭제).
- UI: 칩 + [+ Add] (경로는 Browse=pick-folder, 명령은 텍스트 입력). commands 영역엔
  "Restricted 모드일 때만 적용" 힌트. writePaths 칩 비면 "자동모드(백스톱 밖 허용)" 힌트.

### 3.5 Code repos (신규 desktop/coderepos-file.ts)

- 읽기는 agent-layer의 `loadCodeRepos` 재사용(순수 함수 import — main.ts가 이미
  타 레이어 함수를 쓰는 결). 쓰기 `saveCodeRepos(configDir, cfg)` + 조작 헬퍼
  `setAlias(configDir, alias, path)`·`removeAlias(configDir, alias)`·
  `setSearchRoots(configDir, roots)` (부분 갱신, 나머지 보존).
- alias 유효성: 빈 문자열 거부·trim. 경로는 존재 확인은 안 함(없는 경로 등록 허용 —
  resolveRepo가 어차피 매칭 실패로 처리, 서버 로직 무변경 원칙).
- UI: 목업 확정 — 표(별칭·경로·Delete) + 추가 행(alias 입력·경로 입력·Browse·Add) +
  searchRoots 칩.

### 3.6 Schedules (신규 desktop/schedules-file.ts)

- `listSchedules(configDir): ScheduleEntry[]`(schedules.json 직접 읽기) +
  `removeScheduleFromFile(configDir, id): boolean`.
- ★알려진 경합(문서화·수용): schedules.json은 **서버가 메모리 사본을 들고 쓰는 파일**
  이다. 설정창 삭제는 파일만 고치므로 ① 재시작 전까지 크론은 계속 발사되고 ② 삭제와
  재시작 사이에 서버가 새 예약을 저장하면 삭제분이 부활할 수 있다. 대응: 삭제 직후
  "Restart to apply" 강조 표시. 서버 경유(ws 프레임)로 바꾸는 건 설정창-서버 채널
  신설이 필요해 이번 비범위(후속 신호 오면 그때). // ponytail: 낮은 확률 경합 수용,
  업그레이드 경로 = ws admin 프레임.
- UI: 목업 확정 — 줄(cron mono·task·channelId·once 뱃지·Delete), 빈 목록 문구,
  "새 예약은 채팅에서" 안내.

### 3.7 Wiki sync (신규 desktop/wiki-remote-file.ts)

- `readWikiRemoteFile(configDir): { remote: string, branch: string, syncIntervalSec:
  number }` — 표시용 raw 읽기(knowledge-core `loadWikiRemote`는 remote 없으면 null이라
  폼 초기값용으로 부적합, 파일을 직접 읽어 기본값 채움: branch 'main'·interval 60).
- `saveWikiRemote(configDir, cfg)`: wiki-remote.json 저장. remote 빈 문자열 허용
  (=동기화 끔). interval은 유한 양수만, 아니면 60.
- UI: 목업 확정 — remote(비우면 로컬 전용 힌트)·branch·interval·Save·"인증은 git
  표준(SSH/토큰)" 안내. ENGRAM_WIKI_REMOTE env가 파일보다 우선한다는 힌트 한 줄
  (env 설정 시 폼 값이 무시될 수 있음).

### 3.8 IPC + preload

신규 invoke 채널 (전부 기존 `engram:*` 패턴, 얇은 위임):
`list-brain-details`·`update-brain-profile`·`get-permission-details`·
`set-permission-list`·`get-coderepos`·`set-code-alias`·`remove-code-alias`·
`set-search-roots`·`list-schedules`·`remove-schedule`·`get-wiki-remote`·
`set-wiki-remote`. preload에 1:1 노출. 기존 채널 무변경.

## 4. 테스트

- 신규/확장 desktop 순수 함수 전부 TDD: 부분 갱신·보존·fault-tolerant·경계
  (updateBrainProfile 이름변경+default 이동+충돌 no-op+키 보존 / commands null↔[]
  구분 / removeScheduleFromFile 멱등 / saveWikiRemote interval 검증).
- settings.html은 테스트 하네스 없음(기존과 동일) — 빌드+전체 회귀+수동 스모크.
  사이드바 전환·각 폼 저장 후 파일 내용 확인은 수동 체크리스트로 플랜에 명시.

## 5. 이월 흡수 확인

직전 스펙(2026-07-17-multi-ollama-brains-design.md §5)의 이월 항목 처리:
- 두뇌 프로필 편집·이름변경 UI → §3.3에서 흡수 ✅
- API 두뇌 다중 등록·키 관리 표 → §3.3 편집 패널이 API 두뇌 프로필도 동일하게 편집
  (provider 무관 같은 폼) ✅
- 채팅별 두뇌 선택 UI → 여전히 다음 페이즈(이 페이즈 아님).

## 6. 참고

- permissions.json 스키마: `{ default, allow: { tools: Record<persona,string[]>,
  writePaths: string[], denyPaths: string[], commandMode?: 'auto'|'allowlist'|'off',
  commands?: string[] } }` (permission-fence.ts 기준).
- coderepos.json: `{ aliases: Record<alias,절대경로>, searchRoots: string[] }`.
- schedules.json: `ScheduleEntry[] { id, channelId, threadId?, cron, task, once?,
  createdAt }`.
- wiki-remote.json: `{ remote, branch, syncIntervalSec }`.
- brains.json 프로필 편집 대상 필드: model·baseUrl·apiKey·maxTokens·inputUsdPerMTok·
  outputUsdPerMTok·searchProvider·searchApiKey (provider·cli·concurrency·timeoutMs·
  extraArgs·env는 JSON 유지 — 목업에 없던 필드는 안 늘림).
