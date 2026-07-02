# Phase 6c-2 채널별 권한 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 채널별로 능력(coding/schedule/collaborate)을 잠글 수 있는 정책 층 — `runtime/config/channels.json` + Orchestrator 게이트.

**Architecture:** 순수 정책 모듈 `channel-policy.ts`(로드+판정)를 만들고, Orchestrator(유일 배정구)가 lazy 캐시로 읽어 handleMention 각 분기 진입 직후 게이트한다. DI·생성자 무변경(기존 `codeRepos()` 패턴). 차단 시 안내 게시(막다른 길 없음). observe/ambient 키는 이 플랜에서 정의만 하고 소비는 6c-1 플랜이 한다.

**Tech Stack:** NestJS/TypeScript, Jest. **새 dep 0.** 스펙: `docs/superpowers/specs/2026-07-02-phase6c-ambient-permissions-design.md` §5.2·§5.3.

## Global Constraints

- 셸은 PowerShell(이 머신은 Bash 도구 깨짐). 테스트: `npx jest <파일경로> --silent`.
- 새 의존성 추가 금지. 커밋 프리픽스 `feat(phase6c2):`. 공동 작업자(Co-Authored-By) 넣지 않음.
- 기본값(미설정 채널·미설정 키): **coding/schedule/collaborate/ambient=true, observe=false** — 설정 0이면 현행 동작과 동일(회귀 0).
- 차단 문구: `이 채널에선 코딩을 쓸 수 없어요(채널 설정).` (예약/협업도 같은 패턴).
- 항상 허용(게이트 밖): chat(route)·`ask `·상태·예약목록·예약취소. pending(disambiguate/approve) 경로도 게이트 불요(생성 시 이미 통과, 정책은 재시작 반영).
- Orchestrator 생성자 무변경. 기존 테스트 회귀 0(정책 미설정=전부 허용이므로 기존 스펙은 그대로 초록).

---

### Task 1: `channel-policy.ts` — 정책 로드+판정(순수)

**Files:**
- Create: `src/agent-layer/channel-policy.ts`
- Test: `src/agent-layer/channel-policy.spec.ts`

**Interfaces:**
- Consumes: 없음(fs·configDir만).
- Produces: `type Capability = 'coding' | 'schedule' | 'collaborate' | 'observe' | 'ambient'` · `interface ChannelPolicy { channels: Record<string, Partial<Record<Capability, boolean>>> }` · `loadChannelPolicy(configDir: string): ChannelPolicy` · `allows(policy: ChannelPolicy, channelId: string, cap: Capability): boolean`. Task 2와 6c-1 플랜(bridge·AmbientService)이 import.

- [ ] **Step 1: Write the failing test**

`src/agent-layer/channel-policy.spec.ts`:

```ts
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { loadChannelPolicy, allows } from './channel-policy';

function tmpConfig(json?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cp-'));
  if (json !== undefined) fs.writeFileSync(path.join(dir, 'channels.json'), json);
  return dir;
}

it('기본값: 명령·ambient는 허용, observe만 거부', () => {
  const p = loadChannelPolicy(tmpConfig()); // 파일 없음
  expect(allows(p, 'any', 'coding')).toBe(true);
  expect(allows(p, 'any', 'schedule')).toBe(true);
  expect(allows(p, 'any', 'collaborate')).toBe(true);
  expect(allows(p, 'any', 'ambient')).toBe(true);
  expect(allows(p, 'any', 'observe')).toBe(false);
});

it('부분 설정 병합: 명시한 키만 덮고 나머지는 기본값', () => {
  const p = loadChannelPolicy(tmpConfig('{"c1":{"coding":false,"observe":true}}'));
  expect(allows(p, 'c1', 'coding')).toBe(false);
  expect(allows(p, 'c1', 'observe')).toBe(true);
  expect(allows(p, 'c1', 'schedule')).toBe(true);   // 미설정 키 → 기본
  expect(allows(p, 'c2', 'coding')).toBe(true);      // 미설정 채널 → 기본
});

it('깨진 JSON → 전부 기본값', () => {
  const p = loadChannelPolicy(tmpConfig('{not json'));
  expect(allows(p, 'c1', 'coding')).toBe(true);
  expect(allows(p, 'c1', 'observe')).toBe(false);
});

it('비boolean 값·알 수 없는 키는 무시(기본값)', () => {
  const p = loadChannelPolicy(tmpConfig('{"c1":{"coding":"no","weird":true,"observe":true}}'));
  expect(allows(p, 'c1', 'coding')).toBe(true);   // "no"는 boolean 아님 → 무시
  expect(allows(p, 'c1', 'observe')).toBe(true);
});

it('배열/원시 루트 → 전부 기본값', () => {
  expect(allows(loadChannelPolicy(tmpConfig('[1,2]')), 'c1', 'observe')).toBe(false);
  expect(allows(loadChannelPolicy(tmpConfig('"str"')), 'c1', 'coding')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-layer/channel-policy.spec.ts --silent`
Expected: FAIL — `Cannot find module './channel-policy'`

- [ ] **Step 3: Write minimal implementation**

`src/agent-layer/channel-policy.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

// 채널별 능력 정책(Phase 6c). runtime/config/channels.json — 없음/깨짐이면 전부 기본값(coderepos 패턴).
export type Capability = 'coding' | 'schedule' | 'collaborate' | 'observe' | 'ambient';

export interface ChannelPolicy {
  channels: Record<string, Partial<Record<Capability, boolean>>>;
}

// 기본값: 명령·조용한 ambient는 허용(설정 0=현행 동작), 끼어들기(observe)만 opt-in.
const DEFAULTS: Record<Capability, boolean> = {
  coding: true, schedule: true, collaborate: true, ambient: true, observe: false,
};

export function loadChannelPolicy(configDir: string): ChannelPolicy {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(configDir, 'channels.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const channels: ChannelPolicy['channels'] = {};
      for (const [id, caps] of Object.entries(parsed as Record<string, unknown>)) {
        if (!caps || typeof caps !== 'object' || Array.isArray(caps)) continue;
        const clean: Partial<Record<Capability, boolean>> = {};
        for (const [k, v] of Object.entries(caps as Record<string, unknown>)) {
          if (k in DEFAULTS && typeof v === 'boolean') clean[k as Capability] = v;
        }
        channels[id] = clean;
      }
      return { channels };
    }
  } catch { /* 없음/깨짐 → 기본값 */ }
  return { channels: {} };
}

export function allows(policy: ChannelPolicy, channelId: string, cap: Capability): boolean {
  return policy.channels[channelId]?.[cap] ?? DEFAULTS[cap];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/agent-layer/channel-policy.spec.ts --silent`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```powershell
git add src/agent-layer/channel-policy.ts src/agent-layer/channel-policy.spec.ts
git commit -m "feat(phase6c2): channel-policy — channels.json 로드+판정, 기본 허용·observe만 opt-in"
```

---

### Task 2: Orchestrator 게이트

**Files:**
- Modify: `src/agent-layer/orchestrator.ts` (import + lazy policy() + gate() + 분기 7곳 게이트 삽입)
- Test: `src/agent-layer/orchestrator-gate.spec.ts` (신규)

**Interfaces:**
- Consumes: Task 1 `loadChannelPolicy`/`allows`/`ChannelPolicy` · 기존 `this.paths`(옵셔널 18번째) · 기존 handleMention 분기 구조.
- Produces: `private policy(): ChannelPolicy`(lazy 캐시, 테스트 override 지점) · `private gate(cap, channelId, post): Promise<boolean>`. 6c-1 플랜은 이 파일의 observe에서 policy를 직접 안 씀(bridge가 함) — 게이트 구조 변경 없음.

- [ ] **Step 1: Write the failing test**

`src/agent-layer/orchestrator-gate.spec.ts`:

```ts
import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

// 생성자 18인자(reader..paths). 기존 orchestrator-schedule.spec 패턴.
function orc(classifyJson: string) {
  const brain = { complete: async () => ({ text: classifyJson, costUsd: 0, isError: false }) } as any;
  const registry = { all: () => [] } as any;
  const conversations = { append: async () => {} } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    brain, null as any, null as any, registry, null as any,
  );
  return o as any;
}

// 특정 cap만 거부하는 정책 스텁(채널 c1).
function denyPolicy(...caps: string[]) {
  return { channels: { c1: Object.fromEntries(caps.map((c) => [c, false])) } };
}

it('coding 차단: classify code → 안내, startCoding 미호출', async () => {
  const o = orc('{"kind":"code","repo":"api","goal":"g"}');
  o.policy = () => denyPolicy('coding');
  let called = false; o.startCoding = async () => { called = true; };
  const posts: string[] = [];
  await o.handleMention({ text: 'api에 g', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(called).toBe(false);
  expect(posts[0]).toContain('코딩');
  expect(posts[0]).toContain('쓸 수 없어요');
});

it('coding 차단: code hatch도 동일', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  o.policy = () => denyPolicy('coding');
  let called = false; o.startCoding = async () => { called = true; };
  await o.handleMention({ text: 'code api g', userId: 'c1' }, async () => {});
  expect(called).toBe(false);
});

it('coding 차단: resume hatch(자가 재개 발사)도 안내만', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  o.policy = () => denyPolicy('coding');
  let called = false; o.resumeCoding = async () => { called = true; };
  const posts: string[] = [];
  await o.handleMention({ text: 'resume p1 1', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(called).toBe(false);
  expect(posts[0]).toContain('코딩');
});

it('schedule 차단: classify schedule·hatch → 안내, doSchedule 미호출', async () => {
  const o = orc('{"kind":"schedule","cron":"0 9 * * *","task":"X"}');
  o.policy = () => denyPolicy('schedule');
  let called = false; o.doSchedule = async () => { called = true; };
  const posts: string[] = [];
  await o.handleMention({ text: '매일 9시 X', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.handleMention({ text: 'schedule 0 9 * * * X', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(called).toBe(false);
  expect(posts[0]).toContain('예약');
  expect(posts[1]).toContain('예약');
});

it('schedule 차단 채널에서도 예약목록·예약취소는 동작(읽기/정리)', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  o.policy = () => denyPolicy('schedule');
  o.setScheduler({
    add() { return null; },
    list: () => [{ id: 'x1', cron: '0 9 * * *', task: 'T', channelId: 'c1', createdAt: 't' }],
    remove: (id: string) => id === 'x1',
  } as any);
  const posts: string[] = [];
  await o.handleMention({ text: '예약목록', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.handleMention({ text: '예약취소 x1', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(posts[0]).toContain('#x1');
  expect(posts[1]).toContain('취소');
});

it('collaborate 차단: classify collaborate·team·retry → 안내, launchCollaboration 미호출', async () => {
  const o = orc('{"kind":"collaborate","team":["Manager"]}');
  o.policy = () => denyPolicy('collaborate');
  let called = 0; o.launchCollaboration = () => { called++; };
  const posts: string[] = [];
  await o.handleMention({ text: '정리해줘', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.handleMention({ text: 'team Manager 정리해줘', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.handleMention({ text: 'retry 1 Manager 정리해줘', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(called).toBe(0);
  expect(posts.every((p) => p.includes('협업'))).toBe(true);
});

it('정책 미설정(기본값) → 전부 통과(기존 동작)', async () => {
  const o = orc('{"kind":"chat","team":[]}'); // paths=null → policy()={channels:{}} → 기본 허용
  let called = false; o.startCoding = async () => { called = true; };
  await o.handleMention({ text: 'code api g', userId: 'c1' }, async () => {});
  expect(called).toBe(true);
});

it('차단 채널에서도 chat(route)·ask는 동작', async () => {
  const o = orc('{"kind":"chat","team":[]}');
  o.policy = () => denyPolicy('coding', 'schedule', 'collaborate');
  o.route = async () => '네';
  const posts: string[] = [];
  await o.handleMention({ text: '안녕', userId: 'c1' }, async (t: string) => { posts.push(t); });
  await o.handleMention({ text: 'ask 뭐야', userId: 'c1' }, async (t: string) => { posts.push(t); });
  expect(posts).toEqual(['네', '네']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/agent-layer/orchestrator-gate.spec.ts --silent`
Expected: FAIL — 차단 테스트들이 실패(게이트 없어 startCoding 등 호출됨). '기본값 통과'·'chat 동작'은 PASS일 수 있음(정상).

- [ ] **Step 3: Write minimal implementation**

`src/agent-layer/orchestrator.ts`:

(a) import 추가(coderepos import 근처):

```ts
import { loadChannelPolicy, allows, ChannelPolicy } from './channel-policy';
```

(b) 필드+메서드(codeReposCache·codeRepos() 근처에 동일 패턴):

```ts
  private channelPolicyCache?: ChannelPolicy;

  // 채널 정책 lazy 캐시(6c-2). 변경은 재시작 반영(coderepos와 동일 성질). 테스트는 override.
  private policy(): ChannelPolicy {
    if (!this.channelPolicyCache) {
      this.channelPolicyCache = this.paths ? loadChannelPolicy(this.paths.getConfigDir()) : { channels: {} };
    }
    return this.channelPolicyCache;
  }

  // 채널 능력 게이트(6c-2). 허용이면 true, 차단이면 안내 게시 후 false(막다른 길 없음).
  private async gate(
    cap: 'coding' | 'schedule' | 'collaborate',
    channelId: string,
    post: (text: string) => Promise<void>,
  ): Promise<boolean> {
    if (allows(this.policy(), channelId, cap)) return true;
    const label: Record<string, string> = { coding: '코딩', schedule: '예약', collaborate: '협업' };
    await post(`이 채널에선 ${label[cap]}을 쓸 수 없어요(채널 설정).`);
    return false;
  }
```

(c) handleMention 분기 7곳에 게이트 삽입(각 분기 진입 직후, 실행 함수 호출 직전 — channelId=`msg.userId`):

```ts
    // code hatch — startCoding 호출 앞:
    if (!(await this.gate('coding', msg.userId, post))) return;

    // schedule hatch — doSchedule 호출 앞:
    if (!(await this.gate('schedule', msg.userId, post))) return;

    // resume hatch — resumeCoding 호출 앞:
    if (!(await this.gate('coding', msg.userId, post))) return;

    // retry hatch — if (m) { 안, post('팀 구성…') 앞:
    if (!(await this.gate('collaborate', msg.userId, post))) return;

    // team hatch — post('팀 구성…') 앞:
    if (!(await this.gate('collaborate', msg.userId, post))) return;

    // classify 분기 3곳 — 각 kind 블록 첫 줄:
    if (decision.kind === 'code') {
      if (!(await this.gate('coding', msg.userId, post))) return;
      ...
    if (decision.kind === 'schedule') {
      if (!(await this.gate('schedule', msg.userId, post))) return;
      ...
    if (decision.kind === 'collaborate') {
      if (!(await this.gate('collaborate', msg.userId, post))) return;
      ...
```

예약목록·예약취소·상태·`ask `·chat 폴백·pending 블록은 손대지 않는다.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/agent-layer/orchestrator-gate.spec.ts src/agent-layer/orchestrator-coding.spec.ts src/agent-layer/orchestrator-schedule.spec.ts src/agent-layer/orchestrator-resume.spec.ts src/agent-layer/orchestrator-handle-mention.spec.ts --silent`
Expected: PASS 전부(기존 스펙은 정책 미설정=기본 허용이라 회귀 0)

- [ ] **Step 5: Commit**

```powershell
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-gate.spec.ts
git commit -m "feat(phase6c2): Orchestrator 채널 게이트 — coding/schedule/collaborate 분기·hatch 차단+안내"
```

---

### Task 3: 전체 검증

**Files:** 없음(검증만). 실패 시 해당 태스크로 복귀.

- [ ] **Step 1: 전체 테스트**

Run: `npm test -- --silent`
Expected: 0 fail (기존 402 pass + 신규 ~13, 2 skip)

- [ ] **Step 2: 타입체크·빌드**

Run: `npx tsc --noEmit; npm run build`
Expected: 에러 0

- [ ] **Step 3: 잔여 확인**

`git status --short` — 미커밋 잔여물 없음 확인.
