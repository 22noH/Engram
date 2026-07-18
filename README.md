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
9. **Phase 8a** — 자체 하네스 1단계: API 직접 호출 두뇌(`anthropic-api`·`openai-api`) + 자체 웹검색/웹fetch — claude CLI 없이 단발호출 동작 (코딩 루프는 8b, MCP는 8c 예정)
10. **Phase 8d** — 지휘자 두뇌: 엔그램 하네스 두뇌가 대화 중 등록된 다른 두뇌에게 하위작업을 위임(`ask_brain`) — "리뷰는 클로드로" 같은 지목·막히면 자율 폴백, 넘겨받은 두뇌는 재위임 불가(1단계)
11. **Phase 8b-1** — 엔그램 하네스 코딩: 엔그램 하네스 두뇌가 코딩(파일 편집)을 직접 수행 — 자체 파일 도구루프(읽기/쓰기/편집/찾기), 자기 저장소·작업폴더 밖 쓰기 차단(심링크 우회까지)
12. **Phase 8b-2** — 엔그램 하네스 명령 실행: 코딩 중 두뇌가 셸 명령(`Bash`)을 직접 실행 — 기본 자동(아무 명령이나), 안전은 타임아웃 프로세스트리 종료·출력 상한·git 임시 브랜치 되돌림. 설정창에서 자동/제한/끔 전환 + 기본 두뇌(하네스) 선택

## 설치형 데스크톱 앱 (Phase 7)

- **설치**: GitHub Release에서 OS별 인스톨러(exe/dmg/AppImage) 다운로드 후 실행.
  - 서명이 없어 Windows SmartScreen은 "추가 정보 → 실행", macOS는 앱 우클릭 → 열기로 통과.
- 실행하면 **트레이 아이콘으로 상주**하고, 로그인 시 자동 시작한다(Windows/macOS). 자식(상주)이 죽으면 5초→30초→5분 백오프로 자동 재시작.
- **설정창**(트레이 더블클릭): 상주 상태(heartbeat)·claude CLI 감지·**Anthropic API 키 저장**(claude CLI 없이 두뇌 사용, Phase 8a)·Ollama 로컬 두뇌 추가(**claude CLI 불필요** — openai-api 프로필로 직접 연결)·Discord 봇 토큰 저장·설정 JSON/데이터/로그 폴더 열기.
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

### Use Engram from Claude Code (MCP)

Engram exposes wiki and brain delegation as MCP tools. Connect Claude Code, Codex, or other AI tools running on the same PC:

**HTTP (recommended):**
```bash
claude mcp add --transport http engram http://127.0.0.1:47800/mcp
```

**Stdio bridge (older clients):**
```bash
claude mcp add engram -- node <app>/dist/src/mcp-bridge.js
```

**Available tools:**

| Tool | Description |
|------|-------------|
| `wiki_search` | Search wiki by semantics (embedding-based) |
| `wiki_read` | Read a wiki page by slug |
| `wiki_list` | List all published wiki pages |
| `wiki_propose` | Propose knowledge (human-approved in app) |
| `ask_brain` | Delegate to another registered brain |

*Requires app to be running on this PC. HTTP is localhost-only.*

### 계정 · 원격 접속 (Phase 16a)

Engram 서버(두뇌)는 1인 1계정이다. 앱은 서버에 로그인해야 쓸 수 있다.

1. **서버 세우기**: 서버 머신에서 Engram을 실행하면 로그에 1회용 **설정 코드**가 찍힌다.
   앱 첫 화면("Create your server" — 내 컴퓨터면 코드 자동 입력)에 코드+아이디/비밀번호를
   넣으면 첫 계정(소유자)이 만들어진다.
2. **팀원 초대**: 서버 주소(`ws://…`)를 알려주거나, 주소가 미리 설정된 앱을 나눠준다.
   팀원은 로그인 화면에서 **가입 신청**(또는 SSO 로그인) → 소유자가 관리(Admin) 탭에서 승인.
3. **SSO(선택)**: 관리 탭 서버 설정에 OIDC 발급자·클라이언트를 넣으면(구글 프리셋 버튼)
   "Sign in with SSO" 버튼이 열린다.
4. **로컬 두뇌(+)**: 연산을 내 컴퓨터에서 돌리고 싶으면 Manage Engrams에서 로컬 두뇌를
   추가한다(두뇌 전용 모드 — 로그인 불필요, 지식은 중앙 위키로 합류).

⚠️ 인터넷 노출은 여전히 TLS 앞단(터널/리버스 프록시)이 필수다 — 평문 ws://를 그대로 열지 말 것.

### 팀채팅

`Team` 탭 = **그 서버 Engram의 공용 단톡방**. 여러 사람이 같은 방에 모여 대화하고,
`@Engram`에만 그 서버의 Engram이 답한다(사람끼리는 그냥 대화).

- **참여**: 로그인된 계정으로 그 서버에 접속하면 같은 방을 공유한다.
- **이름**: Team 화면에 표시되는 이름은 **계정의 표시 이름**이다(로그인 시 정한 값 — 자가선언 아님).
  `engram`이라는 이름은 예약이라 계정 생성 시 쓸 수 없다(Engram 사칭 방지).
- **방 = 서버 하나**: 내 앱이 여러 Engram에 붙어 있어도 Team 화면은 지금 고른 하나의
  서버 방만 본다(EngramSelector로 전환). 다른 서버 방과 섞이지 않는다.

### 위키 · 승인함 (Phase 15a)

`Wiki` 탭 = 그 서버 두뇌의 **공용 지식 위키 + 승인함**.

- **페이지**: 쌓인 지식을 목록·필터·문서로 읽는다(선택된 두뇌의 위키).
- **승인함**: 두뇌가 대화에서 뽑아 올린 지식 **제안**이 여기 뜬다. 무엇을(신규/추가/교체)·
  왜(이유·신뢰도·출처)를 보고 **승인**하면 위키에 반영, **거부**하면 버린다.
  (`engram review` CLI와 같은 결재를 클라이언트에서.)
- 실시간: 누가 승인/거부하면 그 두뇌에 접속한 다른 사람 화면도 갱신된다.
- **추가만 가능 — 파괴 불가**: 하드 삭제·게시된 페이지 제거·수동 편집은 15a에 없다
  (되돌릴 수 없는 손실 방지). 수동 편집·소유권 권한은 이후 단계.

### 위키 중앙 저장 (Phase 15b)

여러 두뇌가 하나의 위키를 공유하려면 **중앙 git 원격**에 동기화한다. 위키는 이미 마크다운 +
git이라, 원격만 설정하면 각 두뇌가 주기적으로 pull(남의 지식 받기)·push(내 커밋 보내기)한다.

- 설정: `config/wiki-remote.json` `{ "remote": "git@호스트:me/engram-wiki.git", "branch": "main", "syncIntervalSec": 60 }`
  또는 env `ENGRAM_WIKI_REMOTE`. **미설정이면 로컬 전용(동기화 안 함).**
- 중앙 원격 = GitHub 비공개 저장소 / 사내 git / **자기 서버·NAS의 bare git**(`git init --bare`) 무엇이든.
- 인증은 **git 표준**(SSH 키 권장, 또는 토큰 URL). Engram은 자격증명을 관리하지 않는다 — 실행
  사용자의 git이 접근 가능해야 한다.
- pull로 들어온 지식은 각 두뇌 RAG에 **자동 재색인**된다. git 저장소는 위키 폴더만 —
  RAG·채팅·상태는 각 두뇌 로컬.
- **같은 페이지 동시 편집도 자동 병합된다(Phase 15c)**: frontmatter는 규칙으로 조정(최신 시각·
  출처 합집합·published 우선), 본문은 3-way 병합(서로 다른 곳 추가는 깨끗이 합쳐짐). 같은 줄을
  양쪽이 다르게 고친 진짜 겹침만 기본 두뇌가 합치고, 두뇌가 없거나 실패하면 양쪽을 모두 보존
  (union)한다 — 지식은 사라지지 않고 sync는 안 깨진다.

## 두뇌 설정 (`runtime/config/brains.json`, Phase 8a)

두뇌는 프로필로 갈아끼운다. provider 5종 — 기존 CLI 3종(`claude-cli`·`gemini-cli`·`codex-cli`)에
Phase 8a의 **API 직접 호출 2종**이 추가됐다(하네스까지 Engram 자체 — 해당 CLI 설치 불필요):

```json
{
  "default": "claude",
  "brains": {
    "claude":    { "provider": "claude-cli", "cli": "claude", "model": "" },
    "anthropic": { "provider": "anthropic-api", "model": "claude-opus-4-8", "apiKey": "sk-ant-…" },
    "ollama":    { "provider": "openai-api", "baseUrl": "http://localhost:11434/v1", "model": "llama3.3" }
  }
}
```

- **`anthropic-api`**: Anthropic Messages API 직접 호출. `apiKey` 필수. 설정창의 "Anthropic API 키" 입력으로도 만들어진다.
- **`openai-api`**: OpenAI호환 서버(Ollama·LM Studio·vLLM·OpenAI). `baseUrl`·`model` 필수, `apiKey`는 서버가 요구할 때만. 설정창의 "로컬 두뇌 추가"가 이 프로필을 만든다.
- 두 provider 모두 **자체 웹검색/웹fetch 도구**를 쓴다(기본 DuckDuckGo — 키 불필요). 더 안정적인 검색을 원하면 프로필에 `"searchProvider": "brave"`(또는 `"tavily"`)+`"searchApiKey"`를 추가.
- 비용 추적을 원하면 `"inputUsdPerMTok"`/`"outputUsdPerMTok"`에 모델 단가를 넣는다(기본 0).
- **지휘자(위임, Phase 8d)**: 기본 두뇌가 엔그램 하네스(`anthropic-api`·`openai-api`)면, 대화 중 `brains.json`에 등록된 **다른 두뇌를 직접 불러 쓸 수 있다**(`ask_brain` 도구). "리뷰는 클로드로 해줘"처럼 지목하거나, 막히면 스스로 다른 두뇌에 넘긴다. 넘겨받은 두뇌는 다시 위임하지 못한다(1단계, 무한 재귀 차단). 위임 안내 문구는 `prompts/conductor.md`에서 편집할 수 있다. CLI 두뇌(`claude-cli` 등)가 기본이면 이 기능은 꺼진다(그 두뇌는 자기 하네스로 돌기 때문 — CLI를 지휘자로 쓰는 건 8c/MCP 예정).
- **코딩(Phase 8b-1·8b-2)**: 엔그램 하네스 두뇌(`anthropic-api`·`openai-api`)도 이제 **코딩을 직접** 한다 — 엔그램이 파일 도구루프(읽기/쓰기/편집/glob/grep)를 돌고, **명령 실행(`Bash`)**까지 한다(테스트·린트·빌드를 두뇌가 스스로 돌려보고 고침). 어느 하네스로 코딩할지는 `default` provider로 정한다(`claude-cli`면 claude CLI가, 엔그램 provider면 엔그램이 — 설정창의 "기본 두뇌"에서 고른다).
  - 쓰기는 자기 저장소·시스템·작업폴더 밖을 막는다(심링크/정션 우회까지 realpath로 차단).
  - **명령 실행은 기본이 "자동"** — 두뇌가 아무 명령이나 돌린다(클로드코드 자동모드와 같음). 안전장치는 명령 제한이 아니라 **사고 방지**: 멈춘 명령은 타임아웃에 프로세스 트리째 종료, 출력은 상한, 그리고 **코딩은 git 임시 브랜치에서 일어나므로 망쳐도 버리면 된다**(진짜 되돌림 장치).
  - 제한하고 싶으면 설정창 **"코딩 → 명령 실행"**에서 바꾼다: `자동`(기본) · `제한`(승인 목록만 — 목록 미지정 시 npm·pytest·msbuild 등 내장 기본값) · `끔`(파일 편집만). `permissions.json`의 `allow.commandMode`·`allow.commands`와 같다.
  - 최종 검증(타입체크·빌드·테스트)은 여전히 **엔그램이 직접** 돌린다(두뇌 자기보고 불신).
- API 키는 이 파일에 평문 저장된다(로컬 단일사용자 전제). 변경은 재시작 시 반영.

## 채널 설정 (`runtime/config/channels.json`, Phase 6c)

채널별로 능력을 잠그거나 관찰을 켠다. 없으면 전부 기본값(명령 허용, 끼어들기 꺼짐).

```json
{ "채널ID": { "coding": false, "observe": true } }
```

- `coding`/`schedule`/`collaborate`: 기본 `true` — `false`면 그 채널에서 해당 명령 차단.
- `ambient`: 기본 `true` — 매일 아침(기본 8시, `ENGRAM_AMBIENT_CRON`) 인사이트 요약·위키 결재 대기 알림 게시.
- `observe`: 기본 `false` — `true`면 일반 대화를 관찰해 위키에 관련 정보가 있을 때 💡로 끼어든다(채널당 기본 30분 쿨다운, `ENGRAM_AMBIENT_COOLDOWN_MIN`).

변경은 재시작 시 반영된다.
