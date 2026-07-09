# Phase 14 — 사람 팀채팅 (Team Chat) 설계

작성일: 2026-07-09
상태: 설계 확정(브레인스토밍 산출) — 구현 플랜 대기

---

## 0. 이 문서의 위치 — 큰 그림 속 조각

Phase 11b에서 team 영역 구조만 만들어 flag(`TEAM_CHAT=false`)로 봉인했다("Phase 14가
flag만 켜면 열림"). Phase 13에서 WS 토큰 인증이 들어와 **원격 다인 접속**이 가능해졌다.
Phase 14는 그 둘 위에서 **사람 여러 명이 모이는 공용 단톡방**을 실제로 연다.

로드맵 위치:

| # | 서브프로젝트 | 이번 |
|---|------------|------|
| 13 | 인증 + 원격 | (완료) 토큰 게이트 — 원격 팀원 접속 가능 |
| **14 (이번)** | **사람 팀채팅** | 공용 단톡방 실동작 + 자가선언 표시이름 |
| 15 | 원격/공유 Wiki | 여러 Engram 지식을 한 공간으로 |
| 16 | 다중 사용자/계정 | 인증된 계정·신원·격리·권한 |

**핵심 결정 — 신원은 자가선언 표시이름만.** 검증된 계정(로그인·개별 권한·인증된
작성자)은 Phase 16의 별도 스펙이다. 지금은 각 클라이언트가 닉네임 하나를 스스로
붙이는 **라벨**일 뿐(서버가 검증하지 않음). 공유 토큰을 가진 신뢰 그룹의 방 전제.

---

## 1. 개념 — "그 서버 Engram의 방"

**team 채널 = 한 두뇌(서버) 위의 공유 방.** 그 서버에 접속한 사람들이 모두 같은 방에
모여 대화하고, `@Engram` 멘션에만 **그 서버의 Engram**이 답한다. 사람끼리의 일반
메시지는 그냥 서로에게 브로드캐스트될 뿐(두뇌 미개입).

- 회사 서버에 Engram 하나 = 그 팀 전용 단톡방 + 팀 전용 AI.
- 팀원은 Phase 13 토큰으로 그 서버에 접속해 참여.
- 다른 서버의 Engram은 이 방에 끼어들지 않는다(방은 그 서버 Engram 담당).

**클라이언트가 여러 Engram에 붙어 있어도(Phase 12), team 화면은 지금 고른 하나의
서버 방만 본다.** EngramSelector로 두뇌를 바꾸면 그 두뇌의 team 방으로 전환.

---

## 2. 스코프 — 만드는 것 / 안 만드는 것

**만든다(최소 동작):**
- team 탭 열기(봉인 해제).
- 자가선언 표시이름(닉네임) 설정·영속·전송에 실림.
- team 메시지에 작성자 이름 표시(내 것은 'me', Engram은 Engram, 그 외는 그 이름).
- team 영역은 **단일 연결(선택된 두뇌)로 스코프** — 방 오합침·멘션 오라우팅 회피.
- 서버: 클라가 `authorId`를 `engram`으로 사칭하는 것 차단.

**안 만든다(YAGNI, 사용자가 "최소 동작" 선택):**
- 온라인 사용자 목록·접속/해제 프레즌스(Phase 14+, 서버 상태 필요).
- 타이핑 표시·읽음 확인·멘션 알림·아바타.
- 검증된 계정/로그인/사용자별 권한(Phase 16).
- team 채널의 다중연결 머지(집·회사 방을 한 화면에 섞기) — 의도적 비채택(§1).

---

## 3. 서버 설계 (`self.adapter.ts`)

team 채널 생성(`mode:'team'`, `respondMode:'mention'`), `@Engram` 멘션 반응,
전체 브로드캐스트는 **이미 구현돼 있다**(Phase 9~11b). 서버 변경은 단 하나:

### 3.1 `engram` 이름 예약 (사칭 방지)

`onSend`는 현재 `authorId: f.authorId ?? 'owner'`로 클라가 준 이름을 그대로 쓴다.
클라가 `authorId: 'engram'`으로 보내면 사람이 Engram 행세를 할 수 있다(렌더가
`authorId==='engram'`을 Engram으로 그림). 가드 추가:

```ts
// 클라가 준 authorId가 'engram'(대소문자 무시)이면 사칭 — owner로 강등.
let author = typeof f.authorId === 'string' && f.authorId ? f.authorId : 'owner';
if (author.toLowerCase() === 'engram') author = 'owner';
```

- 'owner'는 그대로 허용(자가선언 이름 미설정 시 폴백).
- 이 가드는 **모든 채널에 적용**(team만이 아니라 — 방어는 채널 무관).
- Engram 자신의 메시지는 `reply`/`postToChannel`이 `authorId:'engram'`을 **서버에서**
  직접 박으므로 영향 없음(클라 경로만 막는다).

### 3.2 non-mention team 메시지

team은 `respondMode:'mention'` → `@Engram` 없는 사람 메시지는 `onSend`의 관찰
경로(`msgHandler`)로 간다. 관찰은 채널 정책 `observe`(기본 false)라 bridge가
필터해 두뇌가 안 끼어든다. **기본 동작이 정확 — 변경 없음.**

---

## 4. 클라이언트 설계 (renderer)

### 4.1 team 탭 열기 (`config.ts`)

`TEAM_CHAT = false` → `true`. `areaTabs(true)`가 `['chat','team','code']` 반환
(이미 구현). Ask/Code 무영향.

### 4.2 표시이름 (신규 `renderer/src/display-name.ts` + UI)

- localStorage `engram.displayName`에 전역 1개 저장(연결과 동형 패턴).
- `loadDisplayName(): string` / `saveDisplayName(name: string): void`.
- team 영역 헤더(또는 빈 상태)에 이름 입력칸 1개. 미설정이면 team 전송을 막고
  "닉네임을 정하세요" 안내(전부 owner로 섞이는 것 방지).

### 4.3 team = 단일 연결 스코프 (`App.tsx`)

team 모드일 때 Ask/Code의 다중연결 머지(`logicalChannels`/`mergeThreads`/
`routeTarget`)를 **쓰지 않고**, 선택된 연결 하나로 스코프한다:

- **활성 team 연결** = `defaultConnId`(EngramSelector가 고르는 값 = 기본 연결. 별도
  선택 상태 없음 — 선택=기본이 하나의 진실원).
- 채널 목록 = `channelsByConn[teamConnId]`의 `mode==='team'` 필터(머지 없음).
- 메시지 = `msgsByConnCh[teamConnId::channelId]`(머지 없음).
- 전송 = `send(teamConnId, {t:'send', channelId, text, authorId: displayName})`
  — `routeTarget` 안 씀(그래서 `@Engram`이 연결 라우팅과 안 부딪히고 멘션으로 전달).
- team 채널 생성 = `teamConnId`에 `createChannel(name, 'team')`.

Ask/Code(`mode!=='team'`)는 기존 다중연결 경로 **완전 무변경**.

### 4.4 렌더링 — 작성자 이름 (`Message`/메시지 렌더)

team 채널 메시지에 작성자 라벨 표시:

- `authorId === displayName` → 'me'(기존 내 메시지 스타일).
- `authorId === 'engram'` → Engram(기존 Engram 스타일).
- 그 외 → 그 사람 이름 라벨 + 사람 메시지 스타일(내 것과 구분).

Ask/Code 렌더는 무변경(단일 사용자라 owner/engram만).

---

## 5. 문서 (README)

"채팅 UI" 절에 team 사용법 추가:
- team 탭 = 그 서버 Engram의 공용 단톡방. 팀원은 Phase 13 토큰으로 접속해 참여.
- 각자 닉네임을 정한다(표시용, 계정 아님).
- `@Engram`에만 그 서버 Engram이 답한다. 사람끼리는 그냥 대화.
- 방은 한 번에 하나의 서버(EngramSelector 선택). 다른 서버 방은 안 섞인다.

---

## 6. 테스트

**서버(self.adapter.spec):**
- 클라 `authorId:'alice'` → 메시지 저장·브로드캐스트에 `alice` 보존.
- 클라 `authorId:'engram'`(대소문자 변형 포함) → `owner`로 강등.
- team 채널(`mode:'team'`) 사람 non-mention 메시지 → 두뇌 미개입(기존 회귀).

**클라(renderer):**
- `display-name` 저장/로드 라운드트립.
- `areaTabs(true)` team 포함(기존 테스트 유지).
- team 스코프: 선택 연결의 team 채널만 목록(머지 안 함) — 두 연결에 동명 team
  채널이 있어도 안 합쳐짐.
- 렌더: team 메시지 작성자 이름/‘me’/Engram 구분.

---

## 7. 파일 영향 요약

| 파일 | 변경 |
|------|------|
| `src/edge/messenger/self.adapter.ts` | `onSend` authorId `engram` 강등 가드 |
| `renderer/src/config.ts` | `TEAM_CHAT = true` |
| `renderer/src/display-name.ts` | (신규) 닉네임 로드/저장 |
| team 이름 입력 UI 컴포넌트 | 닉네임 입력칸 |
| `renderer/src/App.tsx` | team 모드 단일연결 스코프(목록·메시지·전송) + 이름 배선 |
| Message 렌더 컴포넌트 | team 작성자 이름/‘me’/Engram 구분 |
| `README.md` | team 사용법 |

전형적인 하루짜리. 두뇌 코어·오케스트레이터·위키·ws 프레임 계약 무변경.

---

## 8. YAGNI로 자른 것 (되살릴 신호)

- **프레즌스(온라인 목록)·타이핑·읽음·알림·아바타** → 실제 팀 사용 피드백이 요구하면.
- **검증된 계정/권한** → Phase 16.
- **team 다중연결 머지** → 여러 서버 방을 한 화면에 원하면(§1에서 단일연결 채택).
- **표시이름 연결별 분리** → 전역 1개로 충분. 서버마다 다른 이름 필요 시 승격.
