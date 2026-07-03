# Engram

개인용 **stateful LLM 위키(지식 코어)** 를 단일 진실원으로 두고, 에이전트 무리가 그것을 **읽고(A)·협업하고(B)·자율 갱신(C)** 하는 24/7 셀프호스팅 멀티에이전트 시스템.

> 뇌에 저장된 기억의 물리적 흔적(*engram*). stateful 위키(기억 코어)를 은유.

## 문서

- **[설계 문서 (docs/DESIGN.md)](docs/DESIGN.md)** — 아키텍처·결정·로드맵의 단일 기준선

## 상태

설계 확정 — **Phase 0 (KnowledgeCore)** 착수 예정.

## 스택

Node 22+ · NestJS · TypeScript · **LanceDB** · 로컬 임베딩(다국어) · 두뇌 **Claude CLI** (`IBrainProvider` 포트로 교체 가능)

## 플랫폼

**Windows 네이티브 우선** → macOS → Linux. Docker는 선택.

## 빌드 로드맵

1. **Phase 0** — KnowledgeCore (WikiEngine + RagStore + 수집 1경로)
2. **Phase 1** — A 읽기 (ReaderAgent + CLI Gateway)
3. **Phase 2** — C 자율쓰기 (IngesterAgent + 검증 파이프라인 + 승인 게이트)
4. **Phase 3** — B 협업 (Orchestrator + 8팀 + Board Meeting)
5. **Phase 4** — 자율 코딩 협업 (`engram code`)
6. **Phase 5** — InsightLayer + 운영(PAL)
7. **Phase 6** — Tag (@Engram 메신저 동료: 멘션 대화·협업·코딩·예약·ambient)
8. **Phase 7** — 배포·패키징 (Electron 설치형 데스크톱 앱)

## 설치형 데스크톱 앱 (Phase 7)

- **설치**: GitHub Release에서 OS별 인스톨러(exe/dmg/AppImage) 다운로드 후 실행.
  - 서명이 없어 Windows SmartScreen은 "추가 정보 → 실행", macOS는 앱 우클릭 → 열기로 통과.
- 실행하면 **트레이 아이콘으로 상주**하고, 로그인 시 자동 시작한다(Windows/macOS). 자식(상주)이 죽으면 5초→30초→5분 백오프로 자동 재시작.
- **설정창**(트레이 더블클릭): 상주 상태(heartbeat)·claude CLI 감지·Ollama 로컬 두뇌 추가·Discord 봇 토큰 저장·설정 JSON/데이터/로그 폴더 열기.
- **데이터 위치**: OS 사용자 데이터 폴더(Windows `%APPDATA%/Engram`). 기존 레포 `runtime/` 데이터를 옮기려면 폴더 내용을 그대로 복사하면 된다(자동 마이그레이션 없음). `prompts/`·`personas/`는 데이터 폴더에 같은 이름을 두면 사용자 편집본이 우선.
- **임베딩 모델**은 첫 질문 때 자동 다운로드된다(수백 MB, 최초 1회, 데이터 폴더 `models/`에 캐시).
- **개발 실행**: `npm run desktop:dev` · Windows 인스톨러 로컬 빌드: `npm run desktop:build` (산출물 `release/`)
- **릴리스**: `v*` 태그 푸시 → GitHub Actions가 3-OS 인스톨러를 빌드해 Release에 업로드.
- **자동 업데이트(Windows)**: 앱 실행 시 GitHub Release에서 새 버전을 확인해 내려받고 종료 시 설치한다(electron-updater).
  ⚠️ 레포가 private인 동안은 클라이언트가 릴리스에 접근하지 못해 동작하지 않는다 — 릴리스를 public으로 열거나 새 인스톨러를 수동 설치. macOS는 서명이 필요해 자동 업데이트 제외(수동 설치).
- 서버 모드(GUI 없는 상주)는 아래 PAL(`engram service`) 그대로 — 데스크톱 앱과 택일.

## 운영 (PAL)

24/7 상주를 위한 서비스 등록·감시(Phase 5):

- **서비스 등록**: `engram service install | uninstall | start | stop | status`
  - Windows = Windows 서비스(node-windows), Linux = systemd user 유닛, macOS = launchd LaunchAgent. 부팅 자동시작 + 죽으면 OS가 재시작.
  - ⚠️ Linux/macOS 서비스의 실제 동작은 해당 OS에서 검증 필요(개발은 Windows 우선).
- **감시자(watchdog)**: `engram service install` 시 상주(Engram)와 함께 별도 서비스(EngramWatchdog)로 등록된다. 상주가 1분마다 찍는 심장박동이 끊기면(멈춤·죽음) 강제종료(→OS 재시작) + 외부 알림.
- **알림 설정**: `runtime/config/alert.json`에 `{ "webhookUrl": "...", "command": "..." }`(둘 다 선택). 멈춤·메모리 임계치 초과 시 발사.
- **인사이트**: `engram insights` (최신 일일 리포트) · `engram insights run` (즉시 생성).
  - **보존은 기본 무제한(전부 보존)**이다. `ENGRAM_INSIGHT_KEEP_DAYS`/`ENGRAM_HEAP_KEEP`에 양수를 넣으면 그 개수(인사이트=일수, heap=파일수)만 유지하고 초과분을 정리한다. (데이터 삭제는 명시 설정 opt-in.)

## 채팅 UI (Phase 9)

상주가 자체 채팅 서버를 내장한다(기본 `127.0.0.1:47800`). 트레이 → **채팅 열기**,
또는 브라우저에서 `http://127.0.0.1:47800/`.

- 채널 = 대화 기억 단위(채널마다 별도 맥락). 작업 위임 시 진행 보고는 해당
  메시지 밑 🧵 스레드로 접힌다. 스레드 안에서 답장하면 그 작업에 대한 지시가 된다.
- 설정: `config/chat.json` `{ "enabled": true, "port": 47800, "bind": "127.0.0.1" }`
  (env `ENGRAM_CHAT_PORT`/`ENGRAM_CHAT_BIND` 우선). `enabled: false`로 끌 수 있다.
- 채널별 반응 모드: 기본은 모든 메시지에 반응. 채널 ⋯ 메뉴에서 `@Engram` 멘션에만
  반응(나머지는 관찰)으로 바꿀 수 있다.
- Discord는 기존대로 병행 동작한다(`config/messenger.json`).

⚠️ **보안**: 인증이 아직 없다. `bind`를 `127.0.0.1` 이외(외부 개방)로 바꾸지 말 것 —
원격 접속(폰·팀원)은 인증이 들어오는 다음 단계에서 지원된다.

## 채널 설정 (`runtime/config/channels.json`, Phase 6c)

채널별로 능력을 잠그거나 관찰을 켠다. 없으면 전부 기본값(명령 허용, 끼어들기 꺼짐).

```json
{ "채널ID": { "coding": false, "observe": true } }
```

- `coding`/`schedule`/`collaborate`: 기본 `true` — `false`면 그 채널에서 해당 명령 차단.
- `ambient`: 기본 `true` — 매일 아침(기본 8시, `ENGRAM_AMBIENT_CRON`) 인사이트 요약·위키 결재 대기 알림 게시.
- `observe`: 기본 `false` — `true`면 일반 대화를 관찰해 위키에 관련 정보가 있을 때 💡로 끼어든다(채널당 기본 30분 쿨다운, `ENGRAM_AMBIENT_COOLDOWN_MIN`).

변경은 재시작 시 반영된다.
