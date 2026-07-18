# 채널별 두뇌 선택 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 채널 ⋯ 메뉴에서 두뇌를 고르면 그 방의 모든 작업(채팅·코딩·예약·ambient)이 그 두뇌로 돈다. 미설정=기본 두뇌=현행 무변경.

**Architecture:** ChatChannel.brain 필드(chat-store) → self.adapter가 이벤트에 brain 이름 첨부+설정 프레임 → agent-layer가 기존 이름→두뇌 캐시로 해소(실패=기본 폴백) → 렌더러 ⋯ 드롭다운+배지. 스펙: `docs/superpowers/specs/2026-07-18-per-channel-brain-design.md`

**Tech Stack:** 기존 스택 그대로, 신규 dep 없음. 백엔드 jest + 렌더러 vitest.

## Global Constraints

- PowerShell·jest/vitest 포그라운드만. 백엔드 `npm test`, 렌더러 `npm --prefix renderer test -- --run`(기존 스크립트 확인), 빌드 `npm run build`+`npm run renderer:build`.
- 미설정 채널 = 기존과 바이트 동일 동작(회귀 0). 기본 두뇌 싱글턴(BRAIN 주입)·8d 위임·전문가 경로의 기존 계약 무변경.
- 두뇌 해소는 **agent-layer.module의 기존 이름→두뇌 캐시를 재사용**(새 캐시 금지 — 세마포어 분리·인스턴스 정책이 8d에서 검증됨).
- 해소 실패(삭제된 프로필)=기본 두뇌 폴백+warn (throw 금지 — 방 침묵 금지).
- ws 권한: setChannelBrain은 setRespondMode와 동일 게이트. 무효 입력은 조용히 무시(관성).
- UI 문구 en 기본+ko. 커밋 Co-Authored-By 금지.

---

### Task 1: chat-store — ChatChannel.brain + setChannelBrain

**Files:**
- Modify: `src/edge/messenger/chat-store.ts`(+spec)

**Interfaces:**
- Produces (Task 2·3 사용): `ChatChannel.brain?: string`; `setChannelBrain(id: string, brain: string | null): boolean` — null=필드 삭제(기본 복귀), 없는 채널 false. 로드 정규화: brain이 비문자열/빈문자열이면 드롭(respondMode 정규화와 같은 결, chat-store.ts:56-61 참조).

- [ ] **Step 1: TDD** — spec 케이스: ①setChannelBrain 설정→영속 재로드에 남음 ②null 해제→필드 자체 삭제 ③없는 채널 false ④로드 정규화(brain: 123·'' → 드롭) ⑤기존 채널 데이터(브레인 없음) 로드 무변경. 구현은 setRespondMode(:93-99)를 그대로 본뜸.
- [ ] **Step 2: 검증·커밋** — `npm test -- --testPathPattern="chat-store"` PASS. `git commit -m "feat(channel-brain): ChatChannel.brain 필드+setChannelBrain(정규화·해제·영속)"`

---

### Task 2: agent-layer — 채널 두뇌 해소 + 에이전트 배선

**Files:**
- Modify: `src/agent-layer/agent-layer.module.ts`, `src/edge/messenger/messenger.port.ts`(이벤트 타입), `src/agent-layer/reader-agent.ts`(+spec), 채널 문맥 에이전트 경로(코드 확인 후: orchestrator의 handleMention/observe/코딩 위임/예약 재주입 — 실제 파일은 구현자가 추적)

**Interfaces:**
- Consumes: agent-layer.module의 기존 이름→두뇌 캐시(:48·:95·:117에서 쓰는 `cache`+`createBrain(loadBrainProfile(...))` 패턴 — 위임기 resolve와 동일 인스턴스 정책).
- Produces:
  - `MentionEvent`(messenger.port)류 이벤트에 `brain?: string` 옵션 필드(하위호환 — 미첨부=기본).
  - module에 주입 가능한 `ChannelBrainResolver`: `resolve(name: string | undefined): BrainProvider` — undefined→기본 BRAIN, 이름→캐시 resolve, **실패→기본+logger.warn**. (별도 클래스 or 기존 위임기 factory 옆의 소형 provider — 캐시 공유가 조건.)

- [ ] **Step 1: 흐름 추적** — self.adapter→bindMessenger→orchestrator.handleMention/observe의 이벤트 타입과, ReaderAgent·CodingSpecialist·예약 재주입이 두뇌를 얻는 지점을 읽고 배선 지점 목록을 보고서에 적는다. **원칙: 이벤트의 brain을 그 요청 한정으로 해소해 기존 주입 BRAIN 대신 사용** — 싱글턴 필드 오염 금지(요청별 지역 변수).
- [ ] **Step 2: TDD** — resolver: 미지정=주입 BRAIN 그대로·지정=캐시 resolve 결과·존재하지 않는 이름=기본+warn 호출 확인. ReaderAgent: 이벤트 brain 지정 시 그 두뇌의 complete가 불리고 기본 두뇌는 안 불림·지휘자 게이트가 해소 두뇌의 canDelegate 기준·미지정 시 기존 테스트 전부 무변경 통과(회귀 0). 채널 문맥 경로별(observe·코딩·예약) 각 1케이스.
- [ ] **Step 3: 검증·커밋** — `npm test` 전체 PASS·build clean. `git commit -m "feat(channel-brain): 이벤트 brain 해소(기존 캐시 재사용·실패 기본 폴백)+채널 문맥 에이전트 배선"`

---

### Task 3: self.adapter — 이벤트 첨부 + ws 프레임

**Files:**
- Modify: `src/edge/messenger/self.adapter.ts`(+spec)

**Interfaces:**
- Consumes: Task 1 setChannelBrain, Task 2 이벤트 brain 필드, `listBrainNames(configDir)`(brain.config — self.adapter가 configDir 접근 가능한지 확인, 불가면 main에서 names 함수 주입).
- Produces: ①모든 채널 이벤트 생성 지점에서 `brain: ch.brain` 첨부 ②ws `setChannelBrain { channelId, brain: string|null }` — setRespondMode와 동일 권한 게이트+등록 이름 검증(null 허용)+channels 브로드캐스트 ③채널 목록 응답(channels 프레임)에 `brain` 필드 포함+등록 두뇌 이름 목록(기존 channels 응답에 `brainNames` 동봉이 프레임 수 최소 — 기존 구조 보고 결정, 별도 프레임도 허용).

- [ ] **Step 1: 기존 setRespondMode 프레임 처리(권한 게이트 포함)를 읽고 동형 구현.** 무효 이름(미등록·비문자열)=조용히 무시. 검증 목록은 요청 시점에 listBrainNames 재조회(캐시 금지 — 두뇌 추가 직후 반영).
- [ ] **Step 2: TDD** — 권한 있는 소켓 설정 성공+브로드캐스트에 brain 반영·권한 없는 소켓 무시·미등록 이름 무시·null 해제·이벤트에 brain 첨부(멘션 흐름 스파이).
- [ ] **Step 3: 검증·커밋** — `npm test` PASS. `git commit -m "feat(channel-brain): ws setChannelBrain(권한·이름 검증·브로드캐스트)+이벤트 brain 첨부+목록 동봉"`

---

### Task 4: 렌더러 — ⋯ 드롭다운 + 배지

**Files:**
- Modify: `renderer/src/`의 protocol 타입·Channels 컴포넌트(⋯ 메뉴)·i18n(+기존 테스트 파일)

**Interfaces:**
- Consumes: Task 3 프레임(setChannelBrain 송신·channels 응답의 brain/brainNames).
- Produces: ⋯ 메뉴에 "Brain" 드롭다운(항목: `Default (claude)` 형태의 기본 + 등록 이름들, 선택 즉시 프레임 송신, 권한 게이트는 기존 ⋯ 항목 관성) + 채널 목록에 비기본 두뇌 배지(이름 텍스트, 작은 muted 스타일 — 기존 자물쇠 배지 결) + i18n en/ko(`brain: 'Brain'/'두뇌'`, `brainDefault: 'Default'/'기본'` 등 — 기존 i18n 파일 구조 따름).

- [ ] **Step 1: 기존 ⋯ 메뉴(respondMode·visibility 항목)와 배지(자물쇠) 구현을 읽고 동형 추가.**
- [ ] **Step 2: TDD(vitest)** — 드롭다운 렌더(등록 이름+기본)·선택 시 setChannelBrain 프레임 송신·brain 있는 채널 배지 표시·권한 없으면 미표시.
- [ ] **Step 3: 검증·커밋** — `npm --prefix renderer test -- --run` PASS·`npm run renderer:build` clean·백엔드 `npm test` 회귀 확인. `git commit -m "feat(channel-brain): 채널 ⋯ 두뇌 드롭다운+비기본 배지+i18n"`

---

## Self-Review 결과

- 스펙 §3.1→T1, §3.2→T2, §3.3→T3, §3.4→T4, §3.5(폴백)→T2·(배지)→T4, §4 실스모크→SDD 최종(controller: 채널 2개에 서로 다른 두뇌 지정→각 방 응답 두뇌 확인 — computer-use 또는 ws 스크립트).
- 시그니처: ChatChannel.brain/setChannelBrain(1↔3), MentionEvent.brain(2↔3), ChannelBrainResolver(2), 프레임 계약(3↔4). T2가 이벤트 타입을 소유(2가 먼저)·T3이 첨부 — 순서 1→2→3→4.
- 불확실 지점 명시: 채널 문맥 경로의 정확한 배선 지점(T2 Step 1에서 추적·보고)·self.adapter의 configDir 접근(불가 시 주입 폴백)·brainNames 동봉 위치(기존 프레임 구조 따라 결정).
