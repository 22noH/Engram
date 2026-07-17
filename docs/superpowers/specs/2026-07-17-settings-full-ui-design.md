# 설정 전면 UI화 — 설계

날짜: 2026-07-17
상태: 승인됨 (브레인스토밍 완료 — 애플 스타일 목업 확정, 검색 포함)

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

### 3.2 사이드바 + 스타일 가이드 (settings.html 골격 — 애플 시스템 설정 문법)

- `<nav>`(좌, 고정폭 ~170px, `--panel-2` 배경) + 콘텐츠 영역(`--bg`). nav 버튼 클릭 →
  해당 `<section>`만 표시(나머지 `hidden`). 기본 선택 Status.
- **색깔 아이콘 타일**: nav 항목마다 22px 둥근 사각(radius 6) 타일+흰 글리프 —
  Status=초록, Brain=하늘(#3aa5de), Coding=보라, Code repos=주황, Schedules=핑크,
  Wiki sync=청록, Discord=#5865f2, Advanced=회색. 선택 줄은 악센트 채움+흰 글자.
  아이콘은 인라인 SVG(외부 아이콘 폰트·라이브러리 금지 — 8개 글리프만 직접 삽입).
- **검색(상시)**: 사이드바 최상단 검색 필드. 동작 = 섹션명 + 그 섹션의 설정 라벨
  문자열(i18n `t` 기준, 현재 로케일)을 부분일치(대소문자 무시)로 매칭해 **일치하는
  섹션만 사이드바에 표시**, 클릭 시 이동. 비우면 전체 복귀. 행 하이라이트는 비범위
  (후속 신호). 검색 인덱스는 섹션 id→라벨 배열의 정적 매핑 하나(순수 데이터).
- **그룹 인셋 리스트 문법(전 섹션 공통)**: 설정 = "줄" — 라벨 왼쪽·컨트롤/값 오른쪽
  끝 정렬, 줄 사이 0.5px 헤어라인, 그룹 = 둥근(11px) 카드(`--panel`). 그룹 위 작은
  머리글(12px muted), 그룹 아래 회색 캡션 설명문. 인라인 입력은 테두리 없이 오른쪽
  정렬(포커스 시 기존 악센트 링). 목록형(경로·명령·별칭·예약)은 줄마다 왼쪽 빨간
  ⊖ 제거 버튼 + 마지막 줄 "＋ Add…"(악센트 색).
- **생존 신호 상주(시그니처)**: 사이드바 하단에 펄스 점+Running+가동시간 — 기존
  Status 섹션의 pulse 스타일(beat keyframes·reduced-motion 대응) 재사용, 어느 섹션에
  있든 항상 표시. 상태 데이터는 기존 `engram:status` 폴링 재사용.
- 기존 섹션(Status·Brain·Coding·Discord·Advanced)은 이 문법으로 **재스킨**하되 동작
  무변경. 창 크기 상향(사이드바+인셋 리스트 감안, main.ts BrowserWindow 옵션).
- 폰트 = 기존(Segoe UI Variable·Cascadia Mono), 팔레트 = 기존(하늘 악센트·다크모드
  자동). 프레임워크·외부 리소스 추가 없음.

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
- UI(애플 문법): "Registered brains" 그룹 — 줄마다 타일 아이콘+이름/모델, 오른쪽에
  default 체크마크 또는 체브론(›). 줄 클릭(또는 체브론) → 줄 아래로 인셋 편집 폼
  펼침(라벨 왼쪽·입력 오른쪽 정렬, Editing ⌄ 표시) — Save/Cancel 줄로 닫음. 삭제·
  이름변경은 펼친 폼 안(Delete는 default면 비활성). "Add" 그룹 — Ollama 모델 줄
  (셀렉트+이름+Add)과 Anthropic API key 줄(기존 saveApiKey 재사용)을 같은 그룹으로
  이사. Default brain 줄(셀렉트) 유지. 그룹 캡션: default 두뇌 설명 한 줄.

### 3.4 Coding 권한 상세 (permissions-file.ts 확장)

- `getPermissionDetails(configDir)`: `{ writePaths: string[], denyPaths: string[],
  commands: string[] | null }` (commands null = 미지정 → 내장 DEFAULT_COMMANDS 사용 중).
- `setPermissionList(configDir, field, values)`: field ∈ 'writePaths'|'denyPaths'|
  'commands' 부분 갱신. commands는 빈 배열과 미지정(null=필드 삭제)을 구분 —
  빈 배열=전부 거부, 미지정=내장 기본. UI에는 "비우면 내장 기본목록 사용" 안내와
  "기본값으로 되돌리기" 버튼(=필드 삭제).
- UI(애플 문법): writePaths·denyPaths·commands 각각 그룹 — 줄마다 ⊖ 제거 + 마지막
  "＋ Add…" 줄(경로는 Browse=pick-folder, 명령은 인라인 텍스트 입력). 그룹 캡션:
  commands="Restricted 모드일 때만 적용·비우면 내장 기본목록", writePaths 빈 상태=
  "자동모드(백스톱 밖 허용)". commands 그룹에 "기본값으로 되돌리기" 줄(=필드 삭제).

### 3.5 Code repos (신규 desktop/coderepos-file.ts)

- 읽기는 agent-layer의 `loadCodeRepos` 재사용(순수 함수 import — main.ts가 이미
  타 레이어 함수를 쓰는 결). 쓰기 `saveCodeRepos(configDir, cfg)` + 조작 헬퍼
  `setAlias(configDir, alias, path)`·`removeAlias(configDir, alias)`·
  `setSearchRoots(configDir, roots)` (부분 갱신, 나머지 보존).
- alias 유효성: 빈 문자열 거부·trim. 경로는 존재 확인은 안 함(없는 경로 등록 허용 —
  resolveRepo가 어차피 매칭 실패로 처리, 서버 로직 무변경 원칙).
- UI(애플 문법): Aliases 그룹 — 줄마다 ⊖ + 별칭(mono)+경로(muted), "＋ Add…" 줄은
  alias 입력+Browse+Add. Search roots 그룹 — 같은 ⊖/＋ 문법.

### 3.6 Schedules (신규 desktop/schedules-file.ts)

- `listSchedules(configDir): ScheduleEntry[]`(schedules.json 직접 읽기) +
  `removeScheduleFromFile(configDir, id): boolean`.
- ★알려진 경합(문서화·수용): schedules.json은 **서버가 메모리 사본을 들고 쓰는 파일**
  이다. 설정창 삭제는 파일만 고치므로 ① 재시작 전까지 크론은 계속 발사되고 ② 삭제와
  재시작 사이에 서버가 새 예약을 저장하면 삭제분이 부활할 수 있다. 대응: 삭제 직후
  "Restart to apply" 강조 표시. 서버 경유(ws 프레임)로 바꾸는 건 설정창-서버 채널
  신설이 필요해 이번 비범위(후속 신호 오면 그때). // ponytail: 낮은 확률 경합 수용,
  업그레이드 경로 = ws admin 프레임.
- UI(애플 문법): 그룹 안 줄마다 ⊖ + cron(mono·악센트)+task+channelId/once(muted),
  빈 목록 문구. 그룹 캡션: "새 예약은 채팅에서 — '매일 아침 9시에 브리핑해줘'".

### 3.7 Wiki sync (신규 desktop/wiki-remote-file.ts)

- `readWikiRemoteFile(configDir): { remote: string, branch: string, syncIntervalSec:
  number }` — 표시용 raw 읽기(knowledge-core `loadWikiRemote`는 remote 없으면 null이라
  폼 초기값용으로 부적합, 파일을 직접 읽어 기본값 채움: branch 'main'·interval 60).
- `saveWikiRemote(configDir, cfg)`: wiki-remote.json 저장. remote 빈 문자열 허용
  (=동기화 끔). interval은 유한 양수만, 아니면 60.
- UI(애플 문법): 그룹 하나 — Remote·Branch·Sync interval 줄(라벨 왼쪽·입력 오른쪽)+
  Save 줄. 그룹 캡션: "비우면 로컬 전용 · 인증은 git 표준(SSH/토큰) ·
  ENGRAM_WIKI_REMOTE env가 설정되면 파일 값보다 우선".

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
