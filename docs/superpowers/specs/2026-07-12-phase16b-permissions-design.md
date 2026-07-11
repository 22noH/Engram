# Phase 16b — 권한·역할(RBAC 코어) 설계

작성일: 2026-07-12
상태: 설계 확정(브레인스토밍 산출) — 구현 플랜 대기

---

## 0. 이 문서의 위치 — Phase 16 분해

Phase 16("다중 사용자/계정")의 두 번째 조각. 16a(계정·신원)가 owner/member 이분(二分)만
남겼고, **위키 승인함이 로그인만 하면 누구나 승인/거부할 수 있는 구멍**이 있었다. 16b는
행위별 권한을 도입해 그 구멍을 닫는다.

| # | 조각 | 상태 |
|---|------|------|
| 16a | 계정·신원 | 완료(main `08748c7`) |
| **16b (이번)** | **권한·역할(RBAC 코어)** | 세분 권한 + 위키 승인권·채널 관리 게이트 + 소유권 예외 |
| 16b-후속(별도 스펙) | 파괴적 행위 | 하드삭제·게시된 페이지 수정/내림 — 이 권한 모델 위에 얹음 |
| 16c | 격리 | 사용자별 위키 네임스페이스, 비공개 채널 |

**핵심 결정 — 완전 세분 권한(사용자별) + owner 슈퍼유저.** 고정 역할 사다리가 아니라 계정마다
권한 키 집합을 켜고 끈다. owner는 그 위의 전권 슈퍼유저(잠금 불가). 부여/회수는 owner 전용
(권한 상승 위험 차단).

---

## 1. 확정된 모델 (사용자와 합의)

1. **권한 = 문자열 키 집합.** 16b 키 두 개:
   - `wiki.approve` — 위키 제안 승인/거부.
   - `channels.manage` — **남의** 채널 삭제·설정 변경(응답모드·repoPath).
2. **`Account.permissions?: string[]`** — 없으면 빈 권한.
3. **`can(account, perm)`** = `account.role === 'owner' || (account.permissions ?? []).includes(perm)`.
   **owner는 항상 전권**(권한 배열 무관, 체크박스 밖).
4. **채널 생성 = 로그인한 누구나 자유.** 관리(남의 것 건드리기)와 결이 다르다.
5. **소유권 예외.** 채널에 `creatorId`(만든 사람 계정 id) 기록. 자기 채널은 `channels.manage`
   권한 없이도 삭제·설정 가능. 채널 관리 게이트 = `can(me,'channels.manage') || ch.creatorId === me.id`.
   → `channels.manage`는 "남의 채널까지 관리"하는 권한.
6. **부여/회수는 owner 전용.** 위임은 비범위(§7).
7. **무인증(authDeps 없음)·brain 모드 = 전부 허용.** 게이트는 계정이 켜진 서버 모드에서만
   (현행 동작 보존 — 16a와 동일 원칙).

---

## 2. 설계 — 백엔드

### 2.1 권한 헬퍼 (`src/edge/auth/permissions.ts`, 신규)

```ts
export const PERMISSIONS = ['wiki.approve', 'channels.manage'] as const;
export type Permission = (typeof PERMISSIONS)[number];

// owner는 전권. authDeps 없는 무인증 경로는 호출자가 me=undefined로 넘기며, 그때는 게이트를
// 아예 적용하지 않는다(§2.3) — 이 함수는 "계정이 있을 때"의 판정만 담당.
export function can(account: { role: string; permissions?: string[] } | undefined, perm: Permission): boolean {
  if (!account) return false;
  return account.role === 'owner' || (account.permissions ?? []).includes(perm);
}

export function isPermission(v: unknown): v is Permission {
  return typeof v === 'string' && (PERMISSIONS as readonly string[]).includes(v);
}
```

순수 함수 → 단위 테스트로 규칙 고정.

### 2.2 저장소 변경

- **`account-store.ts`**: `Account`에 `permissions?: string[]` 추가. `setPermissions(id, perms: Permission[]): boolean`
  — 알 수 없는 키는 버리고(`isPermission` 필터) 저장. owner 계정에 대한 setPermissions는 no-op
  (owner는 전권이라 배열이 의미 없음 — 혼동 방지).
- **`chat-store.ts`**: `ChatChannel`에 `creatorId?: string` 추가. `createChannel(name, mode, creatorId?)`가
  기록. 기존 채널(`creatorId` 없음)은 소유자 없음 → 관리에 `channels.manage` 필요.

### 2.3 self.adapter 게이트

게이트는 **`authDeps`가 주입된 서버 모드에서만** 적용. `authDeps` 없으면 현행대로 전부 통과
(무인증 로컬·brain). 위반 프레임은 admin 프레임처럼 **조용히 무시**(클라가 애초에 버튼 미표시 —
이중 방어).

- `createChannel`: 로그인만 하면 OK. `creatorId = me.id`(무인증이면 미기록). brain의 team 차단(16a)은 유지.
- `deleteChannel`·`setRespondMode`·`setRepoPath`: 대상 채널을 찾아
  `can(me,'channels.manage') || ch.creatorId === me.id`가 아니면 무시.
- `proposalApprove`·`proposalReject`: `can(me,'wiki.approve')`가 아니면 무시.
- (참고: `me = this.users.get(ws)`. 무인증 모드는 `this.authDeps`가 없으므로 게이트 진입 자체를 건너뜀.)

### 2.4 admin 프레임 추가 (owner 전용 — 16a ADMIN_FRAMES에 합류)

- `adminSetPermissions{ id: string; permissions: Permission[] }` → `accounts.setPermissions(id, perms)` 후
  `adminUsers` 재전송. 기존 admin 게이트(owner 전용) 그대로 적용.

### 2.5 프로토콜 (`shared/protocol.ts`)

- `Channel`에 `creatorId?: string` 추가.
- `UserDto`에 `permissions?: string[]` 추가(authOk가 클라에 자기 권한 전달 — owner는 빈 배열이어도
  role로 전권 판정).
- `AdminUserDto`에 `permissions: string[]` 추가(관리 화면 체크박스 상태).
- `ClientFrame`에 `{ t:'adminSetPermissions'; id: string; permissions: Permission[] }` 추가.

---

## 3. 설계 — 클라이언트

### 3.1 권한 인지

- `authOk`의 `user.permissions`를 `meByConn`에 저장(role과 함께).
- 클라 게이트 헬퍼(`renderer/src/permissions.ts`) `allow(me, perm)` = **`!me || me.role==='owner' || (me.permissions ?? []).includes(perm)`**.
  즉 `me`가 없으면(=무인증 서버라 authOk가 온 적 없음) **제한 없음으로 버튼 표시**, `me`가
  있으면 권한대로 판정. 이 `!me` 단락이 무인증 서버에서 백엔드가 게이트를 건너뛰는 것과 정합을
  이룬다(authDeps 있는 서버는 반드시 authOk를 주므로 member는 권한대로 제한됨).
- 참고: 백엔드 순수 `can(account, perm)`(§2.1)은 계정이 있을 때만 판정(undefined→false)하고,
  무인증은 게이트 진입 자체를 건너뛴다. 클라의 `allow`는 UI 표시용이라 `!me` 단락을 별도로 둔다.

### 3.2 위키 영역(WikiArea)

- 승인/거부 버튼을 `can(me,'wiki.approve')`일 때만 렌더. 권한 없으면 승인함 목록은 **읽기전용**
  (대기 현황은 보되 버튼 없음).

### 3.3 채널(Channels)

- 채널 ⋯메뉴(삭제·응답모드)를 `can(me,'channels.manage') || ch.creatorId === myId`일 때만.
- Code 폴더 바인딩(`setRepoPath`)도 같은 소유/권한 게이트.
- 채널 생성(+)은 항상 표시.
- 이를 위해 사이드바 채널 데이터가 `creatorId`를 실어와야 함(App이 채널 목록에서 전달).

### 3.4 관리 영역(AdminArea)

- 각 멤버 행에 권한 체크박스 2개(`wiki.approve`·`channels.manage`). owner 행은 "all (owner)"
  표시·체크박스 없음(disabled).
- 토글 시 현재 체크 상태로 `adminSetPermissions{id, permissions}` 전송 → 서버 저장 후 `adminUsers`
  재전송으로 갱신.
- `AdminUserDto.permissions`로 체크 상태 표시.

### 3.5 i18n

- 권한 라벨(`permWikiApprove`·`permChannelsManage`), "all (owner)" 등 — 영어 기본 / ko 로케일.

---

## 4. 에러 처리·하위호환

- **이중 방어**: 서버는 위반 프레임 조용히 무시(권위), 클라는 버튼 미표시(UX 주 경로).
- **하위호환**: 기존 member는 이제 위키 승인·남 채널 관리 불가(구멍 닫기 — 의도). owner는 전부 유지.
  `creatorId` 없는 기존 채널은 `channels.manage` 보유자만 관리(자기 것으로 인정될 소유자 없음).
- **무인증/brain 모드**: `authDeps` 없으면 게이트 미적용·`can` UI 제한 없음 — 16a와 동일하게 현행 보존.
- **owner 대상 setPermissions no-op**: owner는 전권이라 권한 배열이 무의미. 관리 UI도 owner 행은
  체크박스 비활성.

---

## 5. 테스트 전략

- `permissions.ts`: 순수 단위 — `can`(owner 단락·권한 있음/없음·미주입 계정)·`isPermission`.
- `account-store`: `setPermissions`(알 수 없는 키 필터·owner no-op·재로드 영속).
- `chat-store`: `createChannel`이 `creatorId` 기록·기존 채널 `creatorId` 없음.
- `self.adapter`: 무권한 승인 무시 / `wiki.approve` 보유자 승인 통과 / 내 채널 삭제 OK / 남 채널
  무권한 무시 / `channels.manage` 보유자 남 채널 관리 OK / adminSetPermissions owner 전용 /
  authOk가 permissions 실어 보냄 / 무인증 모드 전부 통과(회귀).
- 렌더러: 위키 승인 버튼 노출 조건 / 채널 ⋯메뉴 소유·권한 조건 / AdminArea 체크박스 토글→
  adminSetPermissions.
- 기존 스위트 무변경 통과가 회귀 기준.

---

## 6. 파일 구조 (요약)

**백엔드**
- `src/edge/auth/permissions.ts`(신규) — 키·`can`·`isPermission`.
- `src/edge/auth/account-store.ts` — `permissions` 필드·`setPermissions`.
- `src/edge/messenger/chat-store.ts` — `creatorId`·`createChannel` 시그니처.
- `src/edge/messenger/self.adapter.ts` — 게이트(wiki/channel)·`adminSetPermissions`·authOk·adminList permissions.
- `shared/protocol.ts` — Channel.creatorId·UserDto/AdminUserDto.permissions·adminSetPermissions 프레임.

**렌더러**
- `renderer/src/permissions.ts`(신규) — 클라 `can`.
- `renderer/src/App.tsx` — meByConn permissions·채널 creatorId 전달·게이트 배선.
- `renderer/src/components/WikiArea.tsx` — 승인 버튼 게이트.
- `renderer/src/components/Channels.tsx` — ⋯메뉴 소유/권한 게이트(+ myId·권한 props).
- `renderer/src/components/AdminArea.tsx` — 권한 체크박스·adminSetPermissions.
- `renderer/src/i18n.ts` — 권한 라벨.

---

## 7. 이번에 안 하는 것 (되살릴 신호)

- **파괴적 행위**(하드삭제·게시된 페이지 수정/내림) → 별도 후속 스펙. 이 권한 모델 위에 새 키
  (예: `wiki.delete`)로 얹는다.
- **users.manage·server.settings 위임** → 지금은 owner 전용 유지. 실제 위임 요구 시 권한 키 추가.
- **권한 위임(owner 외 부여권)** → 권한 상승 위험. 필요 확인 시.
- **고정 역할 프리셋/번들**("reviewer 묶음") → 권한 2개라 체크박스로 충분. 키가 늘면 재검토.
- **채널 소유권 이전·공동 소유** → 단독 creator로 충분. 요구 시.
