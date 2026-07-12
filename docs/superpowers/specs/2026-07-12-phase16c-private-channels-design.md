# Phase 16c — 비공개 채널 설계

작성일: 2026-07-12
상태: 설계 확정(브레인스토밍 산출) — 구현 플랜 대기

---

## 0. 이 문서의 위치 — Phase 16 분해

Phase 16("다중 사용자/계정")의 마지막 조각.

| # | 조각 | 상태 |
|---|------|------|
| 16a | 계정·신원 | 완료(`08748c7`) |
| 16b | 권한·역할(RBAC 코어) | 완료(`f3c4516`) |
| **16c (이번)** | **비공개 채널** | 초대된 사람만 보이는 채널(`visibility`/`memberIds` 활성화) |

**★범위 결정 — "사용자별 위키 네임스페이스"는 폐기.** 16c의 원래 범위에는 "사용자별 위키
네임스페이스"도 있었으나, Phase 15·16a에서 **위키는 중앙 공유 하나**로 확정(여러 두뇌 지식을
한 위키로 병합)했으므로 사용자별 위키 격리는 그 방향과 정면충돌한다. 구버전 잔재로 간주하고
**버린다**. 16c = 비공개 채널만. (위키 엔진의 `userId` 네임스페이스 배관은 그대로 두되
`DEFAULT_USER` 공유로 계속 사용.)

**핵심 결정 — 비공개는 진짜 초대된 사람만.** 감시 방지를 위해 `channels.manage` 권한자도,
server owner도 초대받지 않으면 비공개 채널을 볼 수 없다(UI상). 셀프호스팅 특성상 owner가
파일·DB를 직접 열람하는 것은 막을 수 없으나(근본 한계), 앱 경험상으로는 프라이버시를 보장한다.

---

## 1. 확정된 모델·접근 규칙 (사용자와 합의)

1. **채널 필드 추가**: `visibility?: 'public' | 'private'`(누락=public), `memberIds?: string[]`
   (비공개 채널 입장 허용 계정 id 목록).
2. **소유자 = 16b `creatorId`**(만든 사람). 씨앗 `ownerId`는 creatorId로 흡수(중복 id 안 만듦).
   생성자는 암묵적으로 항상 멤버(memberIds에 별도 기재 불필요 — 접근 판정이 creatorId도 봄).
3. **비공개 채널 접근권**(볼·쓸 수 있음) = `ch.creatorId === me.id || (ch.memberIds ?? []).includes(me.id)`.
   **owner·channels.manage 예외 없음** — 감시 방지.
4. **비공개 채널 관리**(멤버 초대/해제·visibility·삭제·설정) = **주인(creatorId)만.**
   owner·권한자는 방 자체가 안 보이니 관리 대상에서도 빠진다.
5. **공개 채널 관리**는 16b 그대로: `can(me,'channels.manage') || ch.creatorId === me.id`(+owner 전권).
6. **무인증(authDeps 없음)·brain 모드 = 필터 미적용**(전부 공개처럼 보임 — 현행 보존).

---

## 2. 설계 — 서버 강제 (self.adapter, 권위)

게이트는 `authDeps` 주입된 서버 모드에서만. 위반은 조용히 무시(admin 프레임 관례).

### 2.1 접근 판정 헬퍼

```ts
// 계정이 이 채널을 볼/쓸 수 있는가. public이면 항상 true. private이면 주인이거나 멤버.
private canAccessChannel(ws: WebSocket, ch: ChatChannel): boolean {
  if (!this.authDeps) return true;             // 무인증 모드: 전부 접근
  if ((ch.visibility ?? 'public') !== 'private') return true;
  const me = this.users.get(ws);
  if (!me) return false;
  return ch.creatorId === me.id || (ch.memberIds ?? []).includes(me.id);
}
// 비공개 채널의 관리(멤버·visibility·삭제·설정)는 주인만. 공개 채널은 16b canManageChannel.
private canAdminChannel(ws: WebSocket, ch: ChatChannel | undefined): boolean {
  if (!this.authDeps) return true;
  if (!ch) return false;
  if ((ch.visibility ?? 'public') === 'private') {
    const me = this.users.get(ws);
    return !!me && ch.creatorId === me.id;     // 비공개: 주인만
  }
  return this.canManageChannel(ws, ch);        // 공개: 16b 규칙(creatorId || channels.manage || owner)
}
```

### 2.2 채널 목록 필터 (소켓별)

지금은 `broadcast({t:'channels', list})`로 **한 리스트를 전원에게** 보낸다. 비공개 채널 때문에
**수신자별 필터**가 필요하다.

- **`channels` 요청 응답**: 요청 소켓의 세션 사용자가 접근 가능한 채널만(`canAccessChannel`) 담아 전송.
- **채널 변경 브로드캐스트**(생성·삭제·설정·멤버·visibility 변경 시): `broadcast` 대신
  **각 인증 소켓에 그 소켓 기준으로 필터한 리스트**를 전송(`broadcastChannels()` 신규 헬퍼).
  무인증 모드는 모두에게 전체 리스트(현행).

### 2.3 메시지 방어

- `send`: 대상 채널이 비공개이고 `canAccessChannel`이 아니면 무시(append 안 함).
- `history`: 비공개이고 비접근이면 **빈 목록 반환**(무시 대신 빈 응답 — 클라 로딩 상태 방지).
- (목록에서 안 보이면 애초에 선택 못 하지만, 서버가 권위 — 프레임 위조 방어.)

### 2.4 멤버/가시성 관리 프레임 (신규, 주인만 = `canAdminChannel`)

- `setChannelVisibility{ id, visibility }` — public↔private 전환. private 전환 시 creatorId가
  주인으로 확정(이미 기록됨).
- `setChannelMembers{ id, memberIds }` — 초대 명단 통째 설정(초대=추가, 해제=제거). 유효 계정
  id만 수용(존재하는 account만). creatorId는 목록에 없어도 항상 접근(중복 불필요).

### 2.5 초대용 로스터 프레임 (신규)

비owner 주인도 초대할 사람을 골라야 하므로, 민감정보 없는 가벼운 명단이 필요하다(기존
`adminUsers`는 owner 전용이라 못 씀).

- `channelRoster` 요청 → `{ t:'roster', list: RosterEntry[] }`. `RosterEntry = { id, displayName }`
  (loginId·status·role·permissions 등 제외 — active 계정만).
- 인증된 사용자면 누구나 요청 가능(초대 대상 선택용). 무인증 모드는 빈 목록(계정 개념 없음).

---

## 3. 설계 — 클라이언트

### 3.1 채널 생성

- 채널 생성 UI(+)에 "비공개" 토글. 비공개면 `createChannel` 후 곧바로 `setChannelVisibility` +
  (선택) 초기 멤버. (간단화: 생성은 공개로, 만든 뒤 ⋯메뉴에서 비공개+멤버 지정 — 2스텝 회피.)
  → **채택**: `createChannel`에 `visibility` 옵션을 실어 한 번에(프로토콜 확장).

### 3.2 채널 행 표시

- 비공개 채널 행에 자물쇠 아이콘(🔒 또는 텍스트 마커). `Channel.visibility === 'private'`로 판정.

### 3.3 멤버 관리 UI

- 채널 ⋯메뉴에 "멤버 관리"(주인만 표시 — 클라도 `ch.creatorId === myId`로 게이트, 서버가 권위).
- 클릭 시 로스터(`channelRoster`)를 받아 계정 목록 + 체크박스(현재 memberIds 반영). 토글 시
  `setChannelMembers` 전송.
- "비공개로 전환/공개로 전환" 토글도 같은 메뉴/패널에서 `setChannelVisibility`.

### 3.4 무인증

- 무인증 서버(authOk 없음)면 자물쇠·멤버 관리 UI는 숨김 또는 no-op(서버가 필터 안 하므로 의미 없음).

### 3.5 i18n

- "비공개"/"Private", "멤버 관리"/"Manage members", "공개로 전환"/"Make public" 등 — 영어 기본/ko.

---

## 4. 에러 처리·하위호환

- **이중 방어**: 서버 필터·게이트(권위) + 클라 UI 숨김(주 경로).
- **하위호환**: `visibility` 없는 기존 채널 = public(전원 접근). 무인증 모드 필터 미적용.
  16b 공개 채널 관리 규칙 무변경.
- **브로드캐스트 모델 변경**: 두 브로드캐스트를 소켓별 필터로 바꾼다 — (1) `channels` 리스트는
  각 소켓이 접근 가능한 채널만, (2) `msg`(메시지)는 **비공개 채널이면 그 채널 접근자에게만**
  전송(공개 채널 메시지는 현행대로 전원). `broadcast`에 "이 채널 접근자에게만" 필터 옵션을
  더하는 형태. 이것이 이번의 유일한 구조 변경이다.

---

## 5. 테스트 전략

- self.adapter:
  - 비멤버는 `channels`에서 비공개 채널 안 보임 / 주인·멤버는 봄.
  - 비멤버 `send`/`history` 비공개 채널 → 거부/빈 목록.
  - `setChannelMembers`·`setChannelVisibility` 주인 전용(비주인·권한자·owner도 비공개엔 무시).
  - `channelRoster` = id+displayName만(민감정보 없음), 인증 사용자면 반환.
  - 비공개 채널 `msg` 브로드캐스트가 접근자에게만.
  - 무인증 모드: 전부 보임(회귀).
- 렌더러: 자물쇠 표시·멤버 관리 메뉴 주인 게이트·로스터 체크박스 토글→setChannelMembers·
  생성 시 비공개 옵션.
- 기존 스위트 무변경 통과가 회귀 기준.

---

## 6. 파일 구조 (요약)

**백엔드**
- `shared/protocol.ts` — `Channel.visibility?`·`memberIds?`, `createChannel`에 `visibility?`,
  프레임 `setChannelVisibility`·`setChannelMembers`·`channelRoster`·`{t:'roster',list}`, `RosterEntry`.
- `src/edge/messenger/chat-store.ts` — `visibility`/`memberIds` 필드, `createChannel` visibility 인자,
  `setVisibility(id,v)`·`setMembers(id,ids)` 메서드.
- `src/edge/messenger/self.adapter.ts` — `canAccessChannel`·`canAdminChannel` 헬퍼,
  `broadcastChannels()`(소켓별 필터), `channels`/`send`/`history` 필터, 신규 프레임 처리, roster.

**렌더러**
- `renderer/src/App.tsx` — 채널 목록에 visibility/memberIds 전달, 멤버 관리·비공개 생성 배선, roster 상태.
- `renderer/src/components/Channels.tsx` — 자물쇠 표시, ⋯메뉴 "멤버 관리"(주인 게이트), 비공개 생성 옵션.
- `renderer/src/components/ChannelMembers.tsx`(신규) — 멤버 관리 패널(로스터 체크박스).
- `renderer/src/i18n.ts` — 문구.

---

## 7. 이번에 안 하는 것 (되살릴 신호)

- **사용자별 위키 네임스페이스** → 폐기(중앙 공유 위키와 충돌, §0).
- **1:1 DM 전용 UX**(자동 방 생성·상대 선택) → 비공개 채널로 수동 구성 가능. 전용 DM 흐름은
  실제 요구 시.
- **채널 소유권 이전·공동 소유** → 단독 creator로 충분.
- **비공개 채널 초대 알림/수락** → 초대=즉시 멤버 추가(수락 절차 없음). 필요 시.
- **owner의 비공개 채널 열람(감사 모드)** → 감시 방지 결정에 따라 미채택. 규제 요구 시 옵트인으로.
