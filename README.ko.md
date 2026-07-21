# Engram

[English](README.md) | **한국어**

Engram은 **살아있는 지식 위키**를 중심으로 돌아가는, 내 컴퓨터에서 도는 AI 비서입니다. 나(그리고 내 AI)가 대화하고, 코드를 짜고, 배운 것을 공유 위키에 쌓아가면 — 비서가 그 위키를 읽고 또 스스로 채워 넣으며 **기억**합니다.

> *Engram*: 기억이 뇌에 남기는 물리적 흔적 — Engram의 상태 보존 위키를 가리키는 은유.

모든 게 내 컴퓨터(또는 내 서버)에서 돕니다. 데이터는 밖으로 나가지 않습니다.

---

## 세 가지 사용 형태

맞는 걸 고르세요 — 위키 형식을 공유하므로 섞어 써도 됩니다.

| | 대상 | 로그인 | 받는 법 |
|---|---|---|---|
| **데스크톱 앱** | 내 PC에서 혼자 | 없음 | 설치 파일 다운로드 |
| **팀 서버 + 클라이언트** | 하나의 Engram을 팀이 공유 | 있음(서버별) | 서버 실행 후 클라이언트 배포 |
| **Claude Code 안의 위키** | Claude·Codex 등에서 Engram 위키 사용 | 없음 | `npx engram-wiki-mcp` 또는 플러그인 |

---

## 데스크톱 앱 (개인용)

내 PC에서 전부 돕니다. 계정도 로그인도 없이 — 켜면 바로 씁니다.

1. [GitHub Releases](https://github.com/22noH/Engram/releases)에서 내 OS용 설치 파일을 받아 실행하세요.
   - 서명이 없어서 윈도우는 **추가 정보 → 실행**, macOS는 앱 우클릭 → **열기**로 통과합니다.
2. 트레이에 상주하고 컴퓨터와 함께 켜집니다. 혹시 죽어도 스스로 재시작합니다.

**있는 기능** — 탭 네 개:

- **챗봇** — 내 AI와 대화. 웹 검색·위키 조회로 답합니다.
- **코드** — 폴더를 지정하면 코드를 직접 쓰고 고칩니다(테스트·빌드도 스스로 돌리고 고침).
- **위키** — 쌓인 지식을 검색 가능한 페이지로, 그리고 승인함: AI가 배운 걸 저장하려 하면 여기에 제안하고 내가 승인/거부합니다.
- 트레이 아이콘 우클릭 → **설정**에서 모델·API 키·MCP 도구를 추가합니다(아래).

**데이터**는 OS 사용자 데이터 폴더(윈도우 `%APPDATA%\Engram`)에 저장됩니다. 임베딩 모델은 첫 사용 때 한 번 내려받습니다(수백 MB, 캐시됨).

---

## 팀 서버 + 클라이언트

Engram 하나를 서버로 돌려 팀이 공유합니다. 서버는 **창이 없고**, **아무 컴퓨터의 브라우저에서 웹 콘솔로** 관리합니다.

### 서버 실행

Engram을 서버 모드(헤드리스)로 띄웁니다. 첫 실행 때 1회용 **셋업 코드**가 출력됩니다.

```bash
# 설치된 앱 폴더나 체크아웃에서
ENGRAM_CHAT_BIND=0.0.0.0 ENGRAM_CHAT_PORT=47800 node dist/src/main.js
```

- `ENGRAM_CHAT_BIND=0.0.0.0`은 내부망(LAN)에 엽니다. 기본값 `127.0.0.1`이면 서버 컴퓨터 안에서만.

### 웹 콘솔로 관리

브라우저에서 **`http://<서버주소>:47800/admin`**을 여세요 — 네트워크 안의 아무 컴퓨터에서든.

1. 첫 접속: 셋업 코드를 넣고 **owner(소유자)** 계정을 만듭니다.
2. 그러면 서버 전체를 관리하는 대시보드가 나옵니다:
   - **멤버** — 계정을 직접 생성(임시 비밀번호 발급)하거나 가입 요청을 승인; 정지·비밀번호 리셋·권한 지정.
   - **그룹** — 멤버를 묶어 권한과 채널 접근을 그룹 단위로 한 번에.
   - **채널** — 채널별로 공개/그룹 한정/비공개 설정; 콘솔은 대화 내용을 절대 보여주지 않습니다(감시 방지).
   - **모델** — 이 서버에서 답하는 AI: 하네스 선택·기본 모델 지정·로컬 모델 추가·API 키 저장.
   - **MCP** — 서버의 AI가 쓸 외부 도구. 서버 컴퓨터의 Claude에 붙여둔 MCP는 자동으로 미러링됩니다(읽기 전용).
   - **위키** — 페이지·승인 대기 통계와 위키 동기화용 git 원격(아래).
   - **서버 설정** — 이름·포트·공개 범위·SSO(OIDC)·코딩 허용 여부.
   - **클라이언트 배포** — 앱과 함께 나눠줄 `preset.json`을 내려받아, 팀원 앱이 곧장 이 서버 로그인으로 시작하게.

### 팀원에게 앱 배포

데스크톱 앱과 콘솔에서 받은 `preset.json`을 함께 나눠주세요(앱 설치 폴더에 넣으면 됩니다). 그러면 팀원 앱은 켜자마자 **이 서버의 로그인 화면**으로 시작합니다 — 로그인(또는 가입 요청 → owner 승인)하면 팀의 **채팅** 탭으로 들어가 다 같이 채널에서 대화하고, 서버의 AI가 `@Engram`에 답합니다.

> 서버를 인터넷에 공개하려면 앞단에 TLS(리버스 프록시·터널)가 필요합니다 — 평문으로 바로 열지 마세요.

---

## Claude Code 안의 위키 (MCP)

Engram 위키를 Claude Code·Codex 등 MCP 클라이언트에서 도구로 쓸 수 있습니다 — Engram 앱 없이도. 같은 지식 코어(의미 검색 + 제안·승인 흐름)가 돕니다.

### 플러그인 (추천 — 짧은 명령어 포함)

```bash
claude plugin marketplace add 22noH/Engram
claude plugin install engram@engram
```

이후 아무 프로젝트에서: `/engram:wiki-search <검색어>` · `/engram:wiki-save` · `/engram:proposals` · `/engram:approve <id>`.

### 또는 MCP 서버를 직접 등록

```bash
claude mcp add engram -- npx -y engram-wiki-mcp
```

**도구:**

| 도구 | 하는 일 |
|---|---|
| `wiki_search` | 위키 검색(키워드가 아니라 의미로) |
| `wiki_read` | 페이지 읽기 |
| `wiki_list` | 페이지 목록 |
| `wiki_propose` | 지식 저장 제안 — 승인해야 저장됨 |
| `ask_brain` | 등록된 다른 모델에 하위 작업 위임 |

**승인 없이는 아무것도 저장되지 않습니다.** AI가 지식을 제안하면 대기열에 쌓이고, 채팅에서 검토("제안 보여줘" → "1번 승인")한 뒤에야 반영됩니다. 신뢰하는 자동화가 승인 없이 바로 쓰게 하려면 `--write-mode`를 켜세요.

**데이터는 앱과 공유됩니다.** 헤드리스 모드는 데스크톱 앱과 같은 데이터 폴더를 쓰므로, 여기서 먼저 시작하고 나중에 앱을 깔아도 위키가 그대로 이어집니다. 앱이 이미 켜져 있으면 MCP가 자동으로 앱에 브리지합니다(같은 데이터를 두고 다투지 않게).

---

## 설정

설정은 데이터 폴더의 `config/`에 JSON 파일로 있습니다. 데스크톱 설정창과 서버 웹 콘솔이 대신 편집해 주지만, 직접 고쳐도 됩니다(재시작 시 적용).

### 모델 — `config/brains.json`

어떤 AI가 답할지, 무엇을 더 쓸 수 있는지.

```json
{
  "default": "claude",
  "brains": {
    "claude":    { "provider": "claude-cli", "cli": "claude", "model": "" },
    "anthropic": { "provider": "anthropic-api", "model": "claude-opus-4-8", "apiKey": "sk-ant-…" },
    "qwen":      { "provider": "openai-api", "baseUrl": "http://localhost:11434/v1", "model": "qwen3:8b" }
  }
}
```

- **`claude-cli`**(그리고 `gemini-cli`, `codex-cli`) — 설치된 CLI 도구를 AI로 사용.
- **`anthropic-api`** — Anthropic API 직접 호출(`apiKey` 필요). CLI 불필요.
- **`openai-api`** — OpenAI 호환 서버: **Ollama**·LM Studio·vLLM·OpenAI(`baseUrl`+`model` 필요). **로컬 모델**을 이렇게 돌립니다 — 예: `ollama pull qwen3:8b` 후 `baseUrl`을 `http://localhost:11434/v1`로.
- 기본 DuckDuckGo보다 나은 웹 검색이 필요하면 `"searchProvider": "brave"` + `"searchApiKey"` 추가.
- **채널별 모델**: 채널 ⋯ 메뉴에서 그 방에 답할 모델을 고릅니다 — 코딩방은 Claude, 잡담방은 로컬 qwen 식으로.
- **위임**: API/로컬 모델이 대화 중 다른 등록 모델을 부를 수 있습니다(`ask_brain` 도구) — 이름 지정("리뷰는 Claude로")이나 막혔을 때 스스로.

### MCP 도구 — `config/mcp.json`

AI가 쓸 외부 도구, Claude Code의 `.mcp.json`과 같은 포맷. 같은 컴퓨터의 Claude에 붙여둔 MCP는 **자동으로 미러링**됩니다 — Engram과 Claude가 같은 도구를 공유하도록.

### 채널 — `config/channels.json`

채널별 기능·동작. 항목이 없으면 기본값.

```json
{ "channelId": { "coding": false, "observe": true } }
```

- `coding` / `schedule` / `collaborate`: 기본 켜짐 — `false`면 그 채널에서 차단.
- `observe`: 기본 꺼짐 — 켜면 AI가 대화를 지켜보다 위키에 관련 내용이 있을 때 💡로 끼어듭니다.
- `ambient`: 기본 켜짐 — 매일 아침 인사이트·승인 대기 요약.

### 여러 대에서 위키 공유 — `config/wiki-remote.json`

위키는 마크다운 + git입니다. 중앙 git 원격을 지정하면 각 Engram이 주기적으로 남의 지식을 pull하고 자기 것을 push합니다.

```json
{ "remote": "git@host:team/engram-wiki.git", "branch": "main", "syncIntervalSec": 60 }
```

- 원격은 비공개 GitHub 저장소·사내 git 서버·내 NAS의 bare 저장소 무엇이든.
- 인증은 일반 git 그대로(SSH 키 또는 토큰 URL). 미설정=로컬 전용, 동기화 안 함.
- 같은 페이지 동시 편집은 자동 병합; 진짜 충돌은 AI가 해소하고 실패하면 양쪽을 다 보존 — 지식은 절대 사라지지 않습니다.

---

## 라이선스

Engram은 [GNU AGPL-3.0](LICENSE) 라이선스입니다. 자유롭게 사용·수정·자가 호스팅할 수 있습니다. **앱이나 `engram-wiki-mcp` CLI를 로컬에서 실행하기만 하는 것에는 아무 의무가 없습니다** — 수정본을 배포하거나 Engram을 네트워크 서비스로 남에게 제공할 때만 같은 라이선스로 소스를 공개하면 됩니다.
