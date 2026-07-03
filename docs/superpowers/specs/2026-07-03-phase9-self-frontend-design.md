# Phase 9 — 자체 프론트엔드 (Discord 대체 채팅 UI) 설계

날짜: 2026-07-03
상태: 확정 (구현 대기)
선행: Phase 6(메신저 seam·Tag)·Phase 7(Electron 데스크톱 셸) 완료 기반

## 1. 배경과 목표

로드맵 §11의 최종 도착점 "자체 front-end". Discord 어댑터에 기대던 채팅 경험을
자체 UI로 갖는다. Engram이 설치된 머신이 **채팅 서버(단일 진실원)**가 되고,
Electron 창은 그 서버의 첫 번째 클라이언트일 뿐이다 — 나중에 폰 브라우저·팀원
클라이언트가 같은 서버에 붙는 구조(자가 호스팅 Claude Tag의 완성형).

**확정 결정(대화로):**
- **[D1] 전송로 = WebSocket 서버(상주 내장)** — "지금은 내 PC, 나중에 원격/팀"을
  위해 처음부터 클라이언트-서버 구조. Electron IPC 직결(A안)은 폐기.
- **[D2] 방 구조 = 채널 + 스레드** — 채널은 기억 네임스페이스(기존 seam),
  스레드는 작업 보고 소음 격리용.
- **[D3] 스레드 = 자동 생성만** — Engram의 답/진행 보고가 트리거 메시지 밑에
  자동으로 매달림. 사용자 수동 스레드 생성은 없음. 스레드 안 사용자 답장은 가능
  (재개·취소·추가 지시).
- **[D4] 멘션 모델 = 채널 스위치 `respondMode`** — 기본 `all`(모든 메시지 반응),
  `mention`(멘션만 반응 + 나머지 관찰)은 멀티유저 방을 위한 자리.
- **[D5] 기록 = 파일 영속** — `state/chat/{channelId}.jsonl` append 전용.
  재시작해도 대화 복원.
- **[D6] 멀티유저는 9b로 명시 이월, seam은 지금 판다** — 프로토콜에 `authorId`,
  채널 메타에 `ownerId`/`visibility` 자리. 계정·초대·비공개 잠금·원격 노출
  (바인딩 개방+토큰 인증)·코딩 결과 자동 push는 이번 범위 아님.
  ([[dont-yagni-user-needs]] — 미루는 것이지 버리는 것이 아님.)

## 2. 범위

**이번(Phase 9):**
1. `SelfMessenger` — `MessengerPort` 새 구현 + 내장 WebSocket/HTTP 서버.
2. `ChatStore` — 메시지 JSONL 영속 + 채널 목록(`channels.json`).
3. `MessengerHub` — Discord 병행 시 `postToChannel` 라우팅.
4. Electron "채팅 열기" 창(`chat.html`) — 채널 목록 + 대화 + 스레드 표시.
5. main.ts 결선(자체 서버 상시 가동, Discord는 기존대로 옵션).

**이월(Phase 9b — 별도 brainstorming):**
계정/로그인·초대, 비공개 채널 잠금(visibility 강제), 원격 노출(0.0.0.0 바인딩
+ 토큰 인증 + TLS 또는 Tailscale 안내), 팀원 브라우저 클라이언트 배포,
코딩 완료 시 원격 push. 개인용 로컬 Engram 병행은 Phase 7 인스톨러로 이미 가능
— 만들 것 없음.

## 3. 아키텍처 — 코어·Orchestrator 무변경, 전부 Edge 층

```
[Nest 상주 (main.ts)]
 ├ SelfMessenger (MessengerPort 구현)
 │   ├ http 서버(stdlib) — GET / → chat.html 정적 서빙(폰 브라우저 대비 동일 페이지)
 │   └ ws 서버('ws' dep) — 클라이언트 ↔ 프로토콜(§6)
 │        수신 메시지 → 기록 저장 → onMention/onMessage 발화
 │        reply/postToChannel → 기록 저장 → 전 클라이언트 브로드캐스트
 ├ DiscordMessenger (기존, messenger.json에 있으면 병행)
 ├ MessengerHub (예약·아침브리핑의 postToChannel 라우터)
 └ bindMessenger × 포트별 (기존 bridge 재사용)

[Electron 셸 (desktop/main.ts)]
 └ 트레이 "채팅 열기" → BrowserWindow.loadURL(http://127.0.0.1:PORT)
     — 서버가 서빙하는 chat.html을 그대로 씀(폰과 단일 코드 경로)
```

- **바인딩 기본 `127.0.0.1`**, 포트 기본 `47800`. 설정
  `runtime/config/chat.json { enabled?: boolean, port?: number, bind?: string }`
  (없으면 기본값으로 가동, `enabled:false`만 비활성). env
  `ENGRAM_CHAT_PORT`/`ENGRAM_CHAT_BIND` 우선(기존 config 관례).
- CLI 원샷(`cli.ts`)은 무변경 — 서버는 상주(main.ts) 전용 결선.
- Electron 창은 `did-fail-load`(자식 미기동) 시 백오프 재시도 후 안내 표시.

## 4. 컴포넌트

### 4.1 `src/edge/messenger/self.adapter.ts` — SelfMessenger
- `MessengerPort` 전부 구현(`onMention`·`onMessage`·`reply`·`postToChannel`·
  `start`·`stop`).
- `start()`에서 http+ws 리슨(생성자는 비연결 — Discord 어댑터 관례).
- 수신 `send` → `ChatStore.append`(authorId=클라이언트 제공, 기본 `'owner'`) →
  respondMode 판정: `all`이면 전부 `onMention`, `mention`이면
  `@{engramName}` 포함분만 멘션(토큰 제거 후 전달, Discord
  `stripMentionTokens` 관례 재사용)·나머지는 `onMessage`(관찰, 기존 6c-1 경로).
- `MentionEvent.target = { channelId, anchorId }` — anchor는 **수신 메시지의
  `threadId` ?? 수신 메시지 자신의 id**(스레드 안 답장에 대한 답이 새 스레드를
  파지 않고 같은 스레드에 남음). `reply()`는 `threadId=anchorId`로
  저장+브로드캐스트. → Engram의 모든 답이 트리거 메시지 밑에 매달림(D3).
  `MentionEvent.threadId`는 **수신 메시지의 threadId 그대로**(스레드 안일 때만
  채움) — 채널 본류 멘션은 bridge threadKey=channelId가 되어 기존 Discord
  의미론(`상태` 조회가 채널 단위 집계)과 정합. anchor는 표시용(답 매달기)일 뿐
  작업추적 키가 아니다.
- `postToChannel(channelId, text, threadId?)` — 예약 발사·브리핑용, threadId
  없으면 채널 본류.
- Engram 발신 authorId는 `'engram'` 고정.
- 잘못된 프레임은 무시(fault-tolerant, 기존 관례). 클라이언트별 예외는 접속
  단위로 격리(서버 불사).

### 4.2 `src/edge/messenger/chat-store.ts` — ChatStore
- 메시지: `state/chat/{channelId}.jsonl`, 한 줄 =
  `{ id, authorId, text, threadId?, ts }` (id = `crypto.randomUUID()`).
  손상 줄 skip(ConversationStore 관례).
- 채널: `state/chat/channels.json` —
  `{ id, name, respondMode: 'all'|'mention', ownerId?, visibility? }[]`.
  첫 가동 시 기본 채널 `general` 자동 생성.
- API: `appendMessage` · `history(channelId, {limit, before?})`(최신 N=100 페이지) ·
  `listChannels` · `createChannel(name)` · `deleteChannel(id)`(목록에서만 제거,
  jsonl 파일은 보존 — 데이터 삭제는 opt-in 관례) · `setRespondMode(id, mode)` ·
  `has(channelId)`(Hub 라우팅용).

### 4.3 `src/edge/messenger/messenger-hub.ts` — MessengerHub
- `postToChannel`만 필요로 하는 소비자(ScheduleService·AmbientService)용 얇은
  라우터: `ChatStore.has(channelId)`면 self, 아니면 fallback 포트(Discord).
- Discord 미가동이면 self 단독(라우팅 no-op에 가까움).

### 4.4 `src/desktop/chat.html` + desktop/main.ts 수정
- settings.html 패턴 그대로: 바닐라 JS, 잉크다크+앰버, 시스템 폰트,
  i18n en 기본/ko 로케일(`navigator.language`), 외부 문자열 textContent.
- 좌: 채널 목록(만들기/지우기/respondMode 토글은 채널 컨텍스트에서).
  우: 대화 + 입력창. 브라우저 내장 WebSocket — renderer dep 0.
- **스레드 표시 규칙(D2·D3)**: 같은 threadId(=anchor 메시지)에 매달린 답이
  1개면 인라인(일반 채팅처럼), 2개 이상이면 anchor 밑에 접힌 스레드
  ("답글 N개")로 표시. 스레드 열면 그 안에서 답장 입력 가능
  (`send`에 threadId 포함 → 기존 작업추적 threadKey와 정합).
- 연결 상태 표시 + 끊기면 백오프 재연결.
- 트레이 메뉴 "Open Chat"/"채팅 열기" 항목 추가, 더블클릭 기본을 채팅으로 변경
  (설정은 메뉴에 유지).

### 4.5 `src/main.ts` 결선
- chat.json 로드 → `enabled !== false`면 SelfMessenger 생성·bind·start.
- Discord는 기존 messenger.json 경로 그대로 병행.
- ScheduleService·AmbientService에는 Hub 주입(포트 2개일 때만 의미,
  1개면 그대로 통과).

## 5. 데이터 흐름(대표 시나리오)

1. **일반 질문**: 입력 → ws `send` → append → onMention → bridge →
   `handleMention` → `post()` → reply(threadId=anchor) → 브로드캐스트.
   답 1개 → UI는 인라인 표시.
2. **코딩 위임**: 같은 경로로 들어가 ack·컨펌·진행·결과가 전부 같은 anchor에
   매달림 → 답 여러 개 → UI가 자동으로 스레드 접기. 스레드 안에서
   "1"(후보 선택)·"응"(승인)·`resume ...` 답장 가능.
3. **예약 발사**: ScheduleService → Hub.postToChannel → self 채널이면
   브로드캐스트(+영속). 클라이언트가 하나도 안 붙어 있어도 기록은 쌓임 —
   나중에 창 열면 보임.
4. **재시작**: 클라이언트 재연결 → `history` 요청 → 파일에서 복원.

## 6. ws 프로토콜(JSON 프레임)

클라이언트→서버:
`{t:'send', channelId, threadId?, text, authorId?}` ·
`{t:'history', channelId, before?}` · `{t:'channels'}` ·
`{t:'createChannel', name}` · `{t:'deleteChannel', id}` ·
`{t:'setRespondMode', id, mode}`

서버→클라이언트:
`{t:'msg', channelId, message}`(브로드캐스트) ·
`{t:'history', channelId, messages}` · `{t:'channels', list}` ·
`{t:'error', text}`

버전 협상·바이너리·압축 없음(YAGNI). 알 수 없는 `t`는 무시.

## 7. 보안

- 기본 바인딩 `127.0.0.1` — 같은 머신만 접속. 인증은 이번에 없음(9b에서
  바인딩 개방과 함께 토큰 인증 도입 — 그 전까지 개방 금지를 README에 명시).
- 코딩 위임 경로는 기존 3중 방어 그대로(fence.assertWritable 선검증·
  engramRoot/SYSTEM_DENY 무조건 거부·격리 브랜치) — 자체 UI라고 달라지는
  것 없음.
- channels.json(권한 정책, 기존 6c-2)은 self 채널 ID에도 그대로 적용됨
  (channelGate가 채널 ID만 봄).

## 8. 견고성·에러 처리

- 서버: 프레임 파싱 실패·미지 타입 무시, 클라이언트별 try/catch(한 접속의
  예외가 서버를 못 죽임), stop()으로 깔끔 종료(테스트 누수 방지).
- 클라이언트: 재연결 백오프(1s→5s→30s 캡), 연결 상태 UI 표시.
- 포트 점유 실패: 로그 warn + 채팅만 비활성(상주 본체는 계속 — 메신저 오류
  비활성 관례와 동일).

## 9. 테스트

- 단위: ChatStore(append/history/채널 CRUD/손상줄) · SelfMessenger(실 ws
  임시 포트로 send→onMention 발화, respondMode 분기, reply 브로드캐스트+영속,
  관찰 경로) · Hub 라우팅 · 프로토콜 미지 타입 무시.
- 기존 스위트 무손상(코어 무변경이 지표).
- Electron chat.html은 수동 스모크(설정창 관례): 창 열기→채널 만들기→질문→
  답 표시→재시작→기록 복원→코딩 위임 스레드 접힘.

## 10. 신규 의존성

`ws` 1개(prod). Electron renderer·http 서빙은 stdlib/내장.
