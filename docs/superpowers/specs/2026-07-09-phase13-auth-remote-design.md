# Phase 13 — 인증 + 원격 노출 (Auth + Remote)

작성일: 2026-07-09
상태: 설계 확정(브레인스토밍 산출) — 구현 플랜 대기

---

## 0. 이 문서의 위치 — 큰 그림 속 조각

Phase 9에서 두뇌가 자체 채팅 서버(http 헬스 + ws)를 내장했고, Phase 11~12에서
독립 React 렌더러가 **N개 Engram에 동시 연결**하는 구조를 지었다. 단, 지금까지
서버는 **인증이 전무**하다 — `self.adapter.ts` 주석·README가 명시하듯 `bind`를
`127.0.0.1` 밖으로 바꾸는 것을 "토큰 인증까지 금지"로 막아 두었다.

Phase 13은 그 **빗장을 푸는** 단계다. WS 소켓에 토큰 인증을 넣어, 원격에서
폰·다른 기기로 내 Engram에 붙는 것을 가능하게 한다.

로드맵 분해표 기준 위치:

| # | 서브프로젝트 | 이번 |
|---|------------|------|
| 12 | 다중 연결 | (완료) N개 연결·`@`로 Engram 선택 |
| **13 (이번)** | **인증 + 원격 노출** | ws 토큰 인증. 비로프백 개방의 빗장을 푼다 |
| 14 | 사람 팀 채팅 | 공용 대화 공간 실동작 |
| 16 | 다중 사용자/계정 | 사용자별 신원·격리·권한 |

**핵심 결정 — 이번엔 단일 공유 비밀만.** 사용자별 계정(작성자 신원·개별 revoke·
사용자별 권한)은 Phase 16의 별도 큰 스펙이다. 단일 토큰은 그 부분집합이자
"폰 원격"을 **바로** 푸는 최소 조각이므로 여기서 끝낸다. `authorId`는 `owner`
고정 그대로.

---

## 1. 스코프 — 우리가 만드는 것 / 안 만드는 것

**만든다:** WS 소켓의 토큰 인증 관문. 그거 하나.

**안 만든다(의도적):**
- **릴레이 서버**(클로드코드 원격 방식) — 인터넷에 24/7 노출된 공개 서버 운영은
  별도 프로젝트이자 상시 공격 통로. 위험을 줄이는 건 릴레이가 아니라 토큰 인증이다.
- **터널·리버스 프록시 번들**(Tailscale/cloudflared/nginx) — 도달·TLS는 부품
  선택이지 우리 코드가 아니다. "폰에서 어디서나" 경험은 **Cloudflare Tunnel** 등을
  사용자가 앞에 세우면 그대로 나온다(공개 URL·TLS·포트 개방 없음). 우리는 문서화만.
- **TLS 자체 구현** — 인증서 관리는 프록시/터널의 몫.
- **사용자별 계정**(Phase 16).

정당화: "할 사람이 할 수 있게만 해 놓는다"가 사용자 요구. 우리는 빗장(인증)만 풀고,
도달 수단은 사용자가 고른다.

---

## 2. 위협 모델 & 보안 경계

- **토큰 미설정**: 현행 그대로 — 무인증, 로프백 전제. 하위호환(기본값).
- **토큰 설정**: **모든 연결**이 인증 필요. 로프백 예외 없음.
  - ⚠️ **로프백 예외를 두면 안 되는 이유**: 터널(cloudflared 등)을 앞에 세우면
    원격 트래픽이 전부 로컬(127.0.0.1)에서 들어온 것처럼 보인다. "로프백은 신뢰"
    규칙은 그 순간 인증을 통째로 무력화한다. 그래서 **설정되면 전원 검문**.
- **평문 노출**: 토큰 인증은 소켓 접근만 막는다. 인터넷 노출 시 대화·토큰이 평문
  ws로 흐르지 않도록 **TLS 앞단(터널/프록시)이 필수** — README에 명시.
- **감수하는 위험**: 개인 셀프호스팅 단일 소유자. 뚫려도 소유자 자기 기기만 위험.
  이 위험 수용을 근거로 릴레이 같은 추가 인프라를 짓지 않는다.

---

## 3. 서버 설계

### 3.1 설정 (`chat.config.ts`)

`ChatConfig`에 `token?: string` 추가.

```ts
export interface ChatConfig {
  enabled: boolean;
  port: number;
  bind: string;
  language?: string;
  token?: string; // 설정 시 모든 ws 연결이 auth 프레임으로 이 값을 제시해야 함. 미설정=무인증(현행).
}
```

- `chat.json`의 `token` 문자열 수용. **env `ENGRAM_CHAT_TOKEN` 오버라이드**
  (기존 `ENGRAM_CHAT_PORT`/`ENGRAM_CHAT_BIND` 관례 그대로).
- 빈 문자열/공백/미설정 → `undefined`(무인증). `port`/`bind` 파싱 가드와 동형.
- 이제 `chat.json`은 **비밀을 담을 수 있다** — config 파일 주석/README에서 이를
  명시(기존 "비밀 아님" 주석 갱신).

### 3.2 인증 프레임 (`self.adapter.ts` + `shared/protocol.ts`)

**토큰 전달 = 인증 프레임**(URL 쿼리 아님). 이유: URL 쿼리는 터널·프록시 접속
로그와 브라우저 히스토리에 토큰을 평문으로 남긴다. 추가 ~15줄로 피할 누수.

`shared/protocol.ts` 클라→서버 프레임에 추가:
```ts
{ t: 'auth', token: string }
```
서버→클라(선택, 실패 통지용):
```ts
{ t: 'authErr' }   // 잘못된/누락 토큰 — 서버가 이 프레임 후 소켓 close (선택: 그냥 close만 해도 됨)
```

**연결 상태 머신** (연결당):
1. `wss.on('connection')` 시 소켓을 **미인증**으로 표시(`token` 설정된 경우만; 미설정이면 즉시 인증됨 취급).
2. 미인증 소켓의 프레임 처리:
   - `{t:'auth', token}` 이고 `token === cfg.token` → **인증됨**으로 승격. 이후 정상 처리.
   - 그 외 어떤 프레임이든 → `authErr` 전송 후 소켓 `close`.
3. 인증됨 소켓 → 기존 `handleFrame` 그대로.
4. **인증 타임아웃**: 미인증 상태로 N초(예: 5s) 넘기면 close(느린/악의 접속 정리).

같은 소켓은 프레임 **순서가 보장**되므로, 클라는 `auth`를 쏘고 곧바로 `channels`/
`history`를 연달아 보내도 된다 — 서버가 순서대로 처리해 auth가 먼저 통과한다.
라운드트립 대기 불필요.

미인증 상태 추적: `WeakSet<WebSocket>` 또는 소켓에 심볼 플래그. `wss.clients`를
직접 순회하는 `broadcast`는 **인증된 소켓에만** 보내야 한다(미인증 소켓에 msg가
새지 않도록) — broadcast 루프에 인증 플래그 검사 추가.

### 3.3 하위호환

- `token` 미설정 → `connection` 시 즉시 인증됨 취급 → 기존 경로 100% 동일. 기존
  렌더러·테스트 무변경 통과.

---

## 4. 클라이언트 설계 (renderer)

### 4.1 연결 모델 (`connections.ts`)

`Connection`에 `token?: string` 추가.

```ts
export interface Connection { id: string; name: string; endpoint: string; token?: string }
```

- `loadConnections`/`saveConnections`/`addConnection`: token 통과(localStorage 저장).
- `addConnection(state, name, endpoint, token?)` — token 인자 추가(선택).

### 4.2 Manage Engrams 모달

- 연결 추가/편집 폼에 **토큰 입력칸 1개**(선택). 라벨: "Token (optional)".
- 원격 연결에만 필요 — 로컬은 보통 비움(또는 main 주입).

### 4.3 WS 클라이언트 (`connections-client.ts` / `multi.ts`)

- 소켓 `open` 시 `conn.token`이 있으면 **가장 먼저** `{t:'auth', token}` 전송,
  그다음 기존 오프닝 프레임(`channels` 등).
- `authErr` 수신 또는 인증 실패 close 시: 해당 연결을 **에러 상태**로 표시
  (기존 연결별 `errText` 메커니즘 재사용 — "auth failed" 등). 무한 재연결 루프로
  틀린 토큰을 계속 던지지 않도록, auth 실패는 재연결 백오프에서 구분(선택:
  authErr면 자동 재연결 중단하고 사용자 조치 대기).

### 4.4 로컬 연결 토큰 자동 주입 (데스크톱)

로컬 데스크톱 렌더러는 이미 main이 `?port=`/`?lang=`를 loadFile URL에 주입받는다
(`config.ts`). 토큰도 동형:

- `main.ts`: chat.json에 `token`이 있으면 렌더러 URL에 `?token=<...>` 주입.
- `config.ts`: `?token=` 읽어 `LOCAL_TOKEN` export.
- Local 시드 연결(`connections.ts` `seed()`)이 `LOCAL_TOKEN`을 실어 생성.

→ 소유자가 토큰을 켜도 **로컬 앱은 마찰 0**으로 계속 붙는다.

---

## 5. 문서 (README)

기존 "⚠️ 보안: 인증이 아직 없다. `bind`를 바꾸지 말 것" 단락을 갱신:

- 토큰을 설정하면 비로프백 `bind` 개방이 가능해진다.
- **인터넷 노출 시**: 여전히 TLS 앞단(Cloudflare Tunnel/리버스 프록시)이 필수.
  Engram은 릴레이·터널·TLS를 제공하지 않는다 — 도달 수단은 사용자가 세운다.
- 토큰 설정법: `chat.json` `{ "token": "..." }` 또는 env `ENGRAM_CHAT_TOKEN`.
- 클라이언트: Manage Engrams에서 연결별 토큰 입력.

---

## 6. 테스트

**서버(spec, self.adapter):**
- 토큰 설정 + 올바른 auth 프레임 → 이후 프레임(channels 등) 정상 처리.
- 토큰 설정 + 틀린/누락 auth → 소켓 close, 정상 프레임 미처리, broadcast 미수신.
- 토큰 미설정 → auth 없이도 기존 경로 그대로(하위호환 회귀).
- 인증 타임아웃 → 미인증 방치 소켓 close.

**config(spec):**
- `chat.json` token / env `ENGRAM_CHAT_TOKEN` 오버라이드 / 빈 문자열→undefined.

**클라(renderer):**
- `Connection` token 저장/로드 라운드트립.
- ws 클라: token 있으면 open 시 auth 프레임 선전송(순서).

---

## 7. 파일 영향 요약

| 파일 | 변경 |
|------|------|
| `shared/protocol.ts` | `auth`/`authErr` 프레임 타입 추가 |
| `src/edge/messenger/chat.config.ts` | `token` 필드 + env 오버라이드 |
| `src/edge/messenger/self.adapter.ts` | 인증 상태 머신·타임아웃·broadcast 게이트 |
| `src/desktop/main.ts` | 로컬 렌더러 URL에 `?token=` 주입 |
| `renderer/src/config.ts` | `LOCAL_TOKEN` 읽기 |
| `renderer/src/connections.ts` | `Connection.token` |
| Manage 모달 컴포넌트 | 토큰 입력칸 |
| `renderer/src/ws/connections-client.ts` (+`multi.ts`) | auth 선전송·authErr 처리 |
| `README.md` | 보안 단락 갱신 |

전형적인 하루짜리. 두뇌 코어·오케스트레이터·위키 무변경.

---

## 8. YAGNI로 자른 것 (되살릴 신호)

- **사용자별 계정** → Phase 16(실제 팀원 로그인 필요 시).
- **릴레이/터널/TLS 번들** → 사용자가 세움. Cloudflare 등이 못 하는 구체적 이유가
  생기면 재검토.
- **토큰 회전 CLI(`engram token`)** → 수동 편집으로 충분. 자주 돌릴 필요 생기면 추가.
- **authErr 후 UX(재입력 프롬프트 등)** → 이번은 에러 표시까지. 다듬기는 후속.
