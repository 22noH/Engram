# Phase 7 — 배포·패키징 (단일 설치형 데스크톱 앱) 설계

날짜: 2026-07-02
상태: 승인 대기
근거: DESIGN.md §11 로드맵 "Phase 7 — 배포·패키징", §12 플랫폼 전략

## 1. 목표

지금까지 개발용 CLI(`node dist/src/cli.js`, 레포에서 실행)로 쓰던 Engram을
**더블클릭 설치형 데스크톱 앱**으로 포장한다. 설치하면:

- 트레이 아이콘으로 상주(로그인 시 자동시작), 채팅 UI 없음(대화는 기존대로 Discord/CLI — 자체 채팅 UI는 Phase 9).
- 설정창에서 상태 확인·두뇌 연결(claude/Ollama)·Discord 토큰 설정.
- 데이터는 OS별 사용자 데이터 폴더(`%APPDATA%/engram` 등)에 저장.

**코어(Orchestrator/에이전트/지식 계층) 무변경이 원칙.** 포트+어댑터 seam·PathResolver env·
`main.ts`(상주)/`cli.ts`(원샷) 분리가 이미 있어서, Phase 7은 그 위에 껍데기만 얹는다.

## 2. 확정 결정 (사용자 대화로 확정)

| # | 결정 | 선택 |
|---|---|---|
| D1 | 앱 형태 | **트레이 상주 + 설정창** (채팅 UI는 Phase 9) |
| D2 | OS 범위 | **3종 다 빌드** (Win/Mac/Linux). 단 실검증은 Windows만 가능, Mac/Linux는 CI 빌드 성공까지 (PAL 때와 같은 한계) |
| D3 | claude 의존 | **감지+안내 + Ollama 도우미**. claude CLI는 하네스라 로컬LLM을 붙여도 여전히 필요(제거는 Phase 8 자체 하네스의 몫). Ollama는 모델 백엔드 교체(`ANTHROPIC_BASE_URL` env, Phase 3 구조)로만 |
| D4 | 임베딩 모델 | **첫 실행 다운로드** (transformers.js 내장 다운로드·캐시 재사용, 캐시 경로만 데이터 폴더로) |
| D5 | 상주 방식 | **트레이 앱 = 상주 본체** (Electron 메인이 Nest 자식을 품고 감독). 기존 PAL OS 서비스+watchdog은 서버 모드용으로 유지 |
| D6 | GUI 기술 | **Electron** (Node 앱과 한 몸, 트레이·창·자동시작·3-OS 인스톨러 원스톱, Phase 9가 같은 셸에 올라탐. 설치본 +50~80MB는 수용) |

## 3. 아키텍처

```
[Electron 메인 프로세스]  ← 신규: desktop/
 ├ 트레이 아이콘 (상태 표시 · 메뉴: 설정 열기/재시작/종료)
 ├ 설정창 (BrowserWindow, 필요할 때만)
 ├ 로그인 자동시작 (app.setLoginItemSettings)
 ├ 중복 실행 방지 (requestSingleInstanceLock, 2번째 실행 → 설정창 열기)
 └ 자식 감독: 크래시 → 백오프 재시작 (데스크톱판 watchdog)
      │ utilityProcess.fork
      ▼
[Engram 상주 = dist/src/main.js 그대로]
 ├ env ENGRAM_DATA_DIR = app.getPath('userData')
 ├ env ENGRAM_MODEL_CACHE_DIR = <dataDir>/models
 └ Discord·스케줄·ambient·인사이트 전부 기존 코드
```

- **데이터 위치 전환 = env 한 줄.** `PathResolver`가 이미 `ENGRAM_DATA_DIR`를 지원하므로 코어 수정 0.
  개발 모드(`npm run start`)는 지금처럼 `cwd/runtime`.
- **리소스 번들**: `prompts/`·`personas/`를 electron-builder `files`에 포함. `findRepoRoot`
  (package.json 상향 탐색)가 앱 루트를 그대로 찾으므로 기존 로더 동작. 추가로
  **사용자 편집 오버라이드**: prompt-store·persona 로더가 `dataDir/prompts`·`dataDir/personas`를
  먼저 보고 없으면 번들 폴백.
- **코어 수정은 소형 2건뿐**: ① 위 로더 오버라이드 ② `TransformersEmbedder`가
  `ENGRAM_MODEL_CACHE_DIR` env를 읽어 transformers.js `env.cacheDir`(JS 설정 — OS env를
  자동 인식하지 않음)에 넘기는 한 줄. 미설정 시 기존 기본 캐시 그대로(개발 모드 무변경).
- **감시 역할 분담**: 데스크톱 모드 = Electron 메인이 재시작 담당(watchdog 불필요).
  서버 모드 = 기존 PAL 서비스+watchdog 유지. 삭제 없음.
- **레포 구조**: 단일 패키지 유지. `desktop/`에 Electron 메인 코드(main·preload·설정 화면),
  루트 package.json에 electron·electron-builder devDependencies 추가. 워크스페이스 분리 안 함.

## 4. 설정창

프레임워크 없는 **단순 HTML+TS 한 장** (Phase 9 때 제대로 된 스택으로 교체 — 지금은 YAGNI).
렌더러는 preload IPC로 요청만 하고, **파일 읽기/쓰기·감지는 전부 Electron 메인이 수행**
(Nest 자식을 거치지 않음 — 데이터 폴더 JSON 조작이라 새 프로토콜 불필요).

| 섹션 | 내용 |
|---|---|
| 상태 | 상주 실행 중/중지(판단 = **기존 heartbeat 파일 mtime 재사용**, 신규 IPC 없음), 최근 로그 tail, 재시작 버튼, 임베딩 모델 캐시 준비됨/미준비(용량) |
| 두뇌 연결 | **claude 감지**: `claude --version` 실행 → 설치 여부 표시, 미설치 시 공식 설치 명령 복사 버튼 + 안내. 로그인 감지는 안 함(실 API 콜 비용) — "터미널에서 claude 실행해 로그인" 안내만. **Ollama 도우미**: `localhost:11434` 핑 감지 → 모델 목록 표시 + "로컬 두뇌로 추가" 버튼 = brains.json 프로필 자동 작성(`ANTHROPIC_BASE_URL` env 교체). 미설치 시 다운로드 페이지 안내 |
| 메신저 | Discord 봇 토큰 입력 → `messenger.json` 저장 → 재시작 버튼. 봇 생성 안내 링크 |
| 고급 | JSON 바로 열기(brains/channels/coderepos/schedules), 데이터 폴더 열기, 로그 폴더 열기 |

설정 변경 후 반영은 "재시작 필요" 표시(기존 channels.json 재시작 반영 규칙과 동일).

## 5. 임베딩 모델 (D4)

- 인스톨러에 동봉하지 않는다(수백 MB). transformers.js의 내장 다운로드·캐시를 그대로 쓰고,
  Electron이 자식에 `ENGRAM_MODEL_CACHE_DIR=<dataDir>/models`를 넘긴다(§3 코어 수정 ②).
- 다운로드는 기존처럼 첫 사용 시 자동. 진행률 UI·워밍업 프로토콜은 만들지 않는다 —
  첫 질문이 느린 것으로 수용(진행은 로그에 찍힘). 설정창은 캐시 존재 여부만 표시.

## 6. 인스톨러·CI

- **electron-builder**: Windows NSIS · macOS dmg · Linux AppImage. 버전 = package.json.
- **GitHub Actions 3-OS 매트릭스**(windows/macos/ubuntu): macOS 인스톨러는 macOS에서만
  빌드 가능 → `v*` 태그 푸시 시 빌드해 GitHub Release에 3종 업로드.
  게이트: 기존 테스트 전체 통과 + 3-OS 빌드 성공.
- Windows는 이 머신에서 로컬 빌드·실검증 병행(`npm run desktop:build`).
- **코드 서명 안 함**: 개인용 배포라 비용 대비 불필요. SmartScreen/Gatekeeper 경고 우회
  방법을 README에 기재.
- **자동 업데이트 안 함**: 새 버전 = 새 인스톨러 덮어쓰기. (electron-updater는 서명+서버
  요구 — 필요해지면 후속.)

## 7. 에러 처리

- Nest 자식 크래시 → **백오프 재시작**(5초 → 30초 → 5분), 연속 실패 누적 시 트레이 아이콘
  경고 상태 + 클릭 시 로그 표시. 자식 내부의 기존 alert.json 알림 체계는 그대로 동작.
- 트레이 앱 자체 크래시는 다음 로그인 자동시작으로 복구(개인 데스크톱 수용).
- 기존 `cwd/runtime` → appdata **자동 마이그레이션 안 함**(현 사용자 = 개발자 본인).
  설정창 고급의 "데이터 폴더 열기"로 수동 복사, README에 한 줄 안내.

## 8. 테스트·검증

- `desktop/` 순수 로직(claude 감지 파싱, Ollama 프로필 작성, 백오프 계산, 설정 JSON
  읽기/쓰기, heartbeat 판정)은 **jest 단위테스트** — 기존 체계 그대로.
- 트레이·창·설치는 E2E 프레임워크 없이 **수동 스모크 체크리스트**(Windows 실검증):
  1. 인스톨러 실행 → 설치 완료
  2. 트레이 아이콘 표시 + 상주 기동(heartbeat 갱신)
  3. 설정창: 상태·claude 감지·Ollama 감지 표시
  4. Discord 토큰 입력 → 재시작 → 실봇 멘션 응답
  5. 자식 강제 종료 → 자동 재시작 확인
  6. 로그인 자동시작 확인
  7. 제거(언인스톨) → 앱 삭제, 데이터 폴더는 보존
- Mac/Linux: CI 빌드 성공까지만(실행 검증은 해당 OS 사용자 수동 — PAL 전례).

## 9. 비범위 (후속)

- 자체 채팅 UI → **Phase 9** (이 GUI 셸 위에 올라탐).
- claude CLI 의존 제거(자체 도구 루프) → **Phase 8 자체 하네스**.
- 자동 업데이트·코드 서명 → 필요 시 후속.
- 추론 런타임(Ollama 바이너리/모델) 동봉 → 안 함(수 GB, 사용자가 Ollama에서 받음).
- 데이터 자동 마이그레이션 → 안 함(수동 복사 안내).
