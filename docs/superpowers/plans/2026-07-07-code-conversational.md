# Code 채널 대화 기본 + 명시적 코딩 escalate — 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Code 채널을 "무조건 코딩"에서 "레포 아는 대화가 기본, 코드는 명시적으로 escalate할 때만"으로 바꾼다.

**Architecture:** 두뇌 1콜이 레포를 읽고(읽기전용) 대화체로 답하며, 코드 작업이면 답 끝에 propose 마커를 붙인다. 서버가 마커를 떼서 [구현 시작] 버튼(기존 `actions`)으로 만든다. 클릭하면 기존 `startProposal`(완성조건→승인→자율 루프) 흐름으로 이어진다. 자율 루프(`codeRun`)는 무변경.

**Tech Stack:** NestJS/TypeScript, jest, cross-spawn(claude CLI). 새 dep 0.

## Global Constraints

- 셸은 PowerShell(이 머신 Bash 훅 깨짐). 테스트=`npx jest <패턴>`, 빌드=`npm run build`(nest build).
- `PinoLogger`는 `info()` 없음 — `log`/`warn`/`error`만.
- 언어는 사용자 목표 언어 따라감(무조건 한국어 아님).
- 새 npm 의존성 추가 금지.
- 순수 헬퍼는 fs 접근 금지(테스트 용이) — 파일 읽기는 호출부(orchestrator)가 `loadPrompt`로.
- **renderer 수정 없음** — [구현 시작]은 기존 `ActionButtons`가 렌더. 이 플랜은 백엔드 전용.

## File Structure

- **Create** `src/agent-layer/code-chat.ts` — 순수 헬퍼: `CODE_CHAT_DEFAULT`, `buildCodeChatPrompt`, `extractPropose`. 한 책임(코드-채팅 프롬프트 조립 + 제안 마커 파싱).
- **Create** `src/agent-layer/code-chat.spec.ts` — 위 헬퍼 단위테스트.
- **Create** `prompts/code-chat.md` — 편집 가능한 프롬프트(없으면 `CODE_CHAT_DEFAULT` 폴백).
- **Modify** `src/agent-layer/orchestrator.ts` — `PendingCode`에 `proposeReady` 추가, `answerInCode` 메서드, `mode==='code'` 분기 교체, pending `proposeReady` 소비.
- **Create** `src/agent-layer/orchestrator-code-chat.spec.ts` — Code 채널 대화 흐름 통합테스트.
- **Modify** `src/agent-layer/orchestrator-modes.spec.ts` — 옛 "code→startProposal 직행" 테스트를 새 동작으로 갱신.

---

### Task 1: code-chat 순수 헬퍼 + 프롬프트 파일

**Files:**
- Create: `src/agent-layer/code-chat.ts`
- Test: `src/agent-layer/code-chat.spec.ts`
- Create: `prompts/code-chat.md`

**Interfaces:**
- Produces:
  - `CODE_CHAT_DEFAULT: string`
  - `buildCodeChatPrompt(instruction: string, ctx: { repoPath: string; userText: string; recent?: string; taskStatus?: string }): string`
  - `extractPropose(text: string): { reply: string; goal?: string }`

- [ ] **Step 1: 실패 테스트 작성** — `src/agent-layer/code-chat.spec.ts`

```ts
import { CODE_CHAT_DEFAULT, buildCodeChatPrompt, extractPropose } from './code-chat';

describe('extractPropose', () => {
  it('마커 없으면 답만, goal 없음', () => {
    expect(extractPropose('그냥 설명이야.')).toEqual({ reply: '그냥 설명이야.' });
  });
  it('마커 있으면 떼어내고 goal 뽑음', () => {
    const t = '여기 원인이야.\n```engram:propose\n{"goal":"로그인 버그 고치기"}\n```';
    expect(extractPropose(t)).toEqual({ reply: '여기 원인이야.', goal: '로그인 버그 고치기' });
  });
  it('마커 JSON 깨졌으면 제안 없이 답만(마커는 제거)', () => {
    const t = '답.\n```engram:propose\n{망가짐\n```';
    const r = extractPropose(t);
    expect(r.goal).toBeUndefined();
    expect(r.reply).toBe('답.');
  });
  it('goal 빈 문자열이면 제안 없음', () => {
    const t = '답.\n```engram:propose\n{"goal":"  "}\n```';
    expect(extractPropose(t).goal).toBeUndefined();
  });
});

describe('buildCodeChatPrompt', () => {
  it('{path} 치환 + 사용자 메시지 + 제안 계약 포함', () => {
    const p = buildCodeChatPrompt(CODE_CHAT_DEFAULT, { repoPath: 'C:/r', userText: '왜 막혔어?' });
    expect(p).toContain('C:/r');
    expect(p).toContain('왜 막혔어?');
    expect(p).toContain('```engram:propose');
  });
  it('recent·taskStatus 있으면 섹션으로 붙고, 없으면 생략', () => {
    const withCtx = buildCodeChatPrompt('X {path}', { repoPath: 'C:/r', userText: 'q', recent: 'Q: a\nA: b', taskStatus: '- 코딩: r — failed' });
    expect(withCtx).toContain('최근 대화');
    expect(withCtx).toContain('작업 상태');
    const without = buildCodeChatPrompt('X {path}', { repoPath: 'C:/r', userText: 'q' });
    expect(without).not.toContain('최근 대화');
    expect(without).not.toContain('작업 상태');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest code-chat --silent`
Expected: FAIL — Cannot find module './code-chat'.

- [ ] **Step 3: 최소 구현** — `src/agent-layer/code-chat.ts`

```ts
// Code 채널 대화(2026-07-07): 레포 읽고 대화체로 답, 코드요청이면 답 끝에 propose 마커.
// 순수 헬퍼(fs 접근 없음) — 파일 읽기는 orchestrator가 loadPrompt로 한다.

export const CODE_CHAT_DEFAULT = [
  '너는 Engram이다. 이 레포({path})에 대해 사용자와 대화하며 돕는다.',
  '필요하면 파일을 읽어(읽기 전용) 조사한 뒤 사용자 언어로 간결히 답하라.',
  '질문·설명·논의엔 그냥 답만 한다. 코드를 고치거나 새로 만들라는 요청일 때만 제안 블록을 붙인다.',
].join('\n');

// 프롬프트 조립. instruction은 loadPrompt('code-chat', CODE_CHAT_DEFAULT) 결과.
// propose 계약(마커 형식)은 파서와 묶여 있으므로 여기서 코드가 덧붙인다(사용자가 못 깨게).
export function buildCodeChatPrompt(
  instruction: string,
  ctx: { repoPath: string; userText: string; recent?: string; taskStatus?: string },
): string {
  return [
    instruction.split('{path}').join(ctx.repoPath),
    ctx.taskStatus ? `\n# 지금 이 스레드의 작업 상태\n${ctx.taskStatus}` : '',
    ctx.recent ? `\n# 최근 대화\n${ctx.recent}` : '',
    `\n# 사용자 메시지\n${ctx.userText}`,
    '\n코드를 고치거나 새로 만들라는 요청일 때에만, 답변 맨 끝에 아래 블록을 정확히 덧붙여라(질문·설명·논의엔 절대 금지):',
    '```engram:propose',
    '{"goal":"<한 줄 목표>"}',
    '```',
  ].filter(Boolean).join('\n');
}

// 두뇌 답에서 propose 마커를 떼어내고 goal을 뽑는다. 마커 없거나 깨지면 답만 반환.
export function extractPropose(text: string): { reply: string; goal?: string } {
  const m = text.match(/```engram:propose\s*([\s\S]*?)```/);
  if (!m) return { reply: text.trim() };
  const reply = text.replace(m[0], '').trim();
  try {
    const o = JSON.parse(m[1].trim()) as { goal?: unknown };
    const goal = typeof o.goal === 'string' && o.goal.trim() ? o.goal.trim() : undefined;
    return { reply, goal };
  } catch {
    return { reply }; // 마커 깨졌으면 제안 없이 답만
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest code-chat --silent`
Expected: PASS (2 describe, 6 test).

- [ ] **Step 5: 프롬프트 파일 생성** — `prompts/code-chat.md`

```markdown
너는 Engram이다. 이 레포({path})에 대해 사용자와 대화하며 돕는다.
필요하면 파일을 읽어(읽기 전용) 조사한 뒤 사용자 언어로 간결히 답하라.
질문·설명·논의엔 그냥 답만 한다. 코드를 고치거나 새로 만들라는 요청일 때만 제안 블록을 붙인다(형식은 시스템이 덧붙인다).
```

- [ ] **Step 6: 커밋**

```bash
git add src/agent-layer/code-chat.ts src/agent-layer/code-chat.spec.ts prompts/code-chat.md
git commit -m "feat(code-chat): 대화 프롬프트 조립 + propose 마커 파싱(순수 헬퍼)"
```

---

### Task 2: answerInCode + Code 모드 분기 교체

**Files:**
- Modify: `src/agent-layer/orchestrator.ts` (`PendingCode` 타입, `import`, `answerInCode` 신규, `mode==='code'` 분기 [현 240-248])
- Test: `src/agent-layer/orchestrator-code-chat.spec.ts`

**Interfaces:**
- Consumes: `buildCodeChatPrompt`, `extractPropose`, `CODE_CHAT_DEFAULT`(Task 1); `loadPrompt`(기존); `this.codeBrain.complete(prompt, onChunk?, { cwd, extraArgs })`; `this.tracker.status(threadKey)`; `this.conversations.recent(userId, n)`.
- Produces: `private answerInCode(msg: CoreMessage, threadKey: string): Promise<{ reply: string; goal?: string }>`(조회만 — 게시·pending은 호출 분기가 담당); `PendingCode`에 `{ kind: 'proposeReady'; repoPath: string; goal: string }` 추가.

- [ ] **Step 1: 실패 테스트 작성** — `src/agent-layer/orchestrator-code-chat.spec.ts`

```ts
import { Orchestrator } from './orchestrator';

const logger = { warn() {}, error() {}, log() {} } as any;

// brainText: codeBrain.complete가 돌려줄 텍스트(테스트마다 주입).
function makeOrch(brainText: string) {
  const brain = { complete: async () => ({ text: brainText, costUsd: 0, isError: false }) } as any;
  const conversations = { append: async () => {}, recent: async () => [] } as any;
  const projects = {} as any;                   // truthy(escalate 가능 조건)
  const fence = { assertWritable() {} } as any; // truthy + 허용
  const registry = { all: () => [] } as any;
  const o = new Orchestrator(
    null as any, conversations, logger, null as any,
    null as any, null as any, null as any, null as any,
    projects, null as any, null as any, null as any, null as any,
    brain, fence, null as any, registry, null as any,
  );
  return o;
}

type Posted = { text: string; actions?: any[] };
function collect() {
  const posts: Posted[] = [];
  const post = async (text: string, actions?: any[]) => { posts.push({ text, actions }); };
  return { posts, post };
}

it('Code 채널 질문은 대화 답변만 — 버튼·제안 없음', async () => {
  const orch = makeOrch('여기 원인은 add.js가 없어서야.');
  const { posts, post } = collect();
  await orch.handleMention(
    { text: '왜 막혔어?', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  expect(posts).toHaveLength(1);
  expect(posts[0].text).toContain('원인');
  expect(posts[0].actions).toBeUndefined();
});

it('Code 채널 코드요청은 답변 + [구현 시작] 버튼 + pending=proposeReady', async () => {
  const orch = makeOrch('바로 붙일게.\n```engram:propose\n{"goal":"로그인 붙이기"}\n```');
  const { posts, post } = collect();
  await orch.handleMention(
    { text: '로그인 붙여줘', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  expect(posts).toHaveLength(1);
  expect(posts[0].text).toBe('바로 붙일게.');
  expect(posts[0].actions).toEqual([{ label: '구현 시작', send: '구현 시작' }]);
  // pending이 proposeReady로 세팅됐는지(내부 상태 확인)
  expect((orch as any).pending.get('c1')).toEqual({ kind: 'proposeReady', repoPath: 'C:/repo/app', goal: '로그인 붙이기' });
});

it('Code 모드인데 repoPath 없으면 폴더 안내만', async () => {
  const orch = makeOrch('무시됨');
  const { posts, post } = collect();
  await orch.handleMention({ text: '뭐든', userId: 'c1', mode: 'code' }, post, 'c1');
  expect(posts[0].text).toMatch(/폴더|folder/i);
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest orchestrator-code-chat --silent`
Expected: FAIL — 현재 code 모드는 startProposal 직행이라 posts/actions 기대 불일치.

- [ ] **Step 3: import 추가** — `src/agent-layer/orchestrator.ts` (기존 `import { loadPrompt } from './prompt-store';` 아래)

```ts
import { buildCodeChatPrompt, extractPropose, CODE_CHAT_DEFAULT } from './code-chat';
```

- [ ] **Step 4: PendingCode에 proposeReady 추가** — `src/agent-layer/orchestrator.ts` (현 62-64)

기존:
```ts
type PendingCode =
  | { kind: 'disambiguate'; candidates: string[]; goal: string }
  | { kind: 'approve'; projectId: string; path: string };
```
교체:
```ts
type PendingCode =
  | { kind: 'disambiguate'; candidates: string[]; goal: string }
  | { kind: 'approve'; projectId: string; path: string }
  | { kind: 'proposeReady'; repoPath: string; goal: string };
```

- [ ] **Step 5: answerInCode 메서드 추가** — `src/agent-layer/orchestrator.ts` (`startProposal` 바로 위에 추가)

```ts
// Code 채널 대화(2026-07-07): 레포 읽고(읽기전용) 대화체로 답 + 코드요청이면 goal 추출.
// 조회만 한다 — 게시·pending은 호출 분기(Step 6)가 결정. 읽기전용이라 게이트 없음(질문=chat 동급).
private async answerInCode(msg: CoreMessage, threadKey: string): Promise<{ reply: string; goal?: string }> {
  if (!this.codeBrain || !msg.repoPath) return { reply: '지금 답하기 어려웠어요 🙏' };

  let recent = '';
  try {
    const recs = await this.conversations.recent(msg.userId, 6);
    recent = recs.map((r) => `Q: ${r.question}\nA: ${r.answer.slice(0, 400)}`).join('\n');
  } catch { /* 연속성 실패는 무시 — 답변은 계속 */ }

  const tasks = this.tracker.status(threadKey);
  const taskStatus = tasks.length ? tasks.map((t) => `- ${t.question} — ${t.state}`).join('\n') : '';

  const prompt = buildCodeChatPrompt(loadPrompt('code-chat', CODE_CHAT_DEFAULT), {
    repoPath: msg.repoPath, userText: msg.text.trim(), recent, taskStatus,
  });
  // 읽기전용 도구 + --add-dir로 레포 읽기 보장(헤드리스 claude가 cwd 밖을 막을 수 있음).
  const r = await this.codeBrain.complete(prompt, undefined, {
    cwd: msg.repoPath,
    extraArgs: ['--allowedTools', 'Read,Glob,Grep,WebSearch,WebFetch', '--add-dir', msg.repoPath],
  });
  if (r.isError) return { reply: '지금 답하기 어려웠어요 🙏' };
  return extractPropose(r.text);
}
```

- [ ] **Step 6: mode==='code' 분기 교체** — `src/agent-layer/orchestrator.ts` (현 238-248)

기존:
```ts
    // Code 채널(Phase 10): classify 건너뛰고 바인딩된 repoPath로 바로 코딩(오분류 차단).
    // 벽은 아님 — 위의 escape hatch(team/ask/code/schedule)가 이미 처리됐다면 여기 안 옴.
    if (msg.mode === 'code') {
      if (!msg.repoPath) {
        await post('이 채널엔 아직 작업 폴더가 없어요. 채널에 들어가 폴더를 먼저 선택해 주세요 📁');
        return;
      }
      if (!(await this.channelGate('coding', msg.userId, post))) return;
      await this.startProposal(msg.repoPath, trimmed, threadKey, post);
      return;
    }
```
교체(대화 기본 — 게이트는 escalate 시점으로 이동, 게시·pending은 여기서):
```ts
    // Code 채널(2026-07-07): 대화 기본. 레포 읽고 답하고, 코드요청이면 [구현 시작] 제안(escalate).
    // 대화 자체는 게이트 없음(질문=chat과 동급). 코딩 게이트는 '구현 시작' 클릭 시(proposeReady 처리).
    if (msg.mode === 'code') {
      if (!msg.repoPath) {
        await post('이 채널엔 아직 작업 폴더가 없어요. 채널에 들어가 폴더를 먼저 선택해 주세요 📁');
        return;
      }
      const { reply, goal } = await this.answerInCode(msg, threadKey);
      if (goal && this.fence && this.projects) {
        this.pending.set(threadKey, { kind: 'proposeReady', repoPath: msg.repoPath, goal });
        await post(reply, [{ label: '구현 시작', send: '구현 시작' }]);
      } else {
        await post(reply); // 코딩 미배선이거나 순수 대화면 답만
      }
      return;
    }
```

- [ ] **Step 7: 통과 확인**

Run: `npx jest orchestrator-code-chat --silent`
Expected: PASS (3 test).

- [ ] **Step 8: 커밋**

```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-code-chat.spec.ts
git commit -m "feat(orchestrator): Code 채널 대화 기본(answerInCode) + 코드요청 시 [구현 시작] 제안"
```

---

### Task 3: [구현 시작] escalate 소비 + 옛 테스트 갱신

**Files:**
- Modify: `src/agent-layer/orchestrator.ts` (`handleMention` pending 블록 [현 145-168])
- Modify: `src/agent-layer/orchestrator-code-chat.spec.ts` (escalate 테스트 추가)
- Modify: `src/agent-layer/orchestrator-modes.spec.ts` (옛 startProposal 직행 테스트 갱신)

**Interfaces:**
- Consumes: `this.pending`(kind `proposeReady`, Task 2); `this.startProposal(targetPath, goal, threadKey, post)`(기존); `this.channelGate('coding', userId, post)`(기존).
- Produces: pending `proposeReady`에서 `'구현 시작'` → `startProposal`, 비매칭 → pending 삭제 후 통과.

- [ ] **Step 1: 실패 테스트 작성** — `src/agent-layer/orchestrator-code-chat.spec.ts` 하단에 추가

```ts
it('[구현 시작] 누르면 startProposal로 escalate', async () => {
  const orch = makeOrch('바로 붙일게.\n```engram:propose\n{"goal":"로그인 붙이기"}\n```');
  const spyProposal = jest.spyOn(orch as any, 'startProposal').mockResolvedValue(undefined);
  const { post } = collect();
  // 1) 코드요청 → pending=proposeReady
  await orch.handleMention(
    { text: '로그인 붙여줘', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  // 2) 구현 시작 → startProposal(repoPath, goal)
  await orch.handleMention(
    { text: '구현 시작', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  expect(spyProposal).toHaveBeenCalledWith('C:/repo/app', '로그인 붙이기', 'c1', expect.any(Function));
  expect((orch as any).pending.get('c1')).toBeUndefined(); // proposeReady 소비됨
});

it('proposeReady 중 비매칭 메시지는 제안을 버리고 일반 대화로 흐른다', async () => {
  const orch = makeOrch('그건 이래.'); // 두 번째 턴은 마커 없는 일반 답
  const spyProposal = jest.spyOn(orch as any, 'startProposal').mockResolvedValue(undefined);
  const { posts, post } = collect();
  (orch as any).pending.set('c1', { kind: 'proposeReady', repoPath: 'C:/repo/app', goal: 'X' });
  await orch.handleMention(
    { text: '아니 그거 말고 이건 뭐야?', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' }, post, 'c1',
  );
  expect(spyProposal).not.toHaveBeenCalled();
  expect((orch as any).pending.get('c1')).toBeUndefined(); // 스테일 제안 정리
  expect(posts[posts.length - 1].text).toContain('그건 이래'); // 대화로 응답
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest orchestrator-code-chat --silent`
Expected: FAIL — proposeReady 처리 없어 '구현 시작'이 answerInCode로 흘러 startProposal 미호출.

- [ ] **Step 3: pending proposeReady 소비 추가** — `src/agent-layer/orchestrator.ts` (`p.kind === 'approve'` else-if 블록 뒤, 현 167 `}` 앞에 else-if 추가)

기존:
```ts
      } else if (p.kind === 'approve' && (trimmed === '승인' || trimmed === 'approve')) {
        this.pending.delete(threadKey);
        await this.approveProject(p.projectId);
        this.launchCoding(p.projectId, p.path, threadKey, post);
        return;
      }
    }
```
교체(else-if 하나 추가):
```ts
      } else if (p.kind === 'approve' && (trimmed === '승인' || trimmed === 'approve')) {
        this.pending.delete(threadKey);
        await this.approveProject(p.projectId);
        this.launchCoding(p.projectId, p.path, threadKey, post);
        return;
      } else if (p.kind === 'proposeReady') {
        if (trimmed === '구현 시작' || trimmed === '승인' || trimmed === 'approve') {
          this.pending.delete(threadKey);
          if (!(await this.channelGate('coding', msg.userId, post))) return;
          await this.startProposal(p.repoPath, p.goal, threadKey, post);
          return;
        }
        // 비매칭 → 스테일 제안 버리고 아래 일반 흐름으로(disambiguate와 동일 패턴)
        this.pending.delete(threadKey);
      }
    }
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest orchestrator-code-chat --silent`
Expected: PASS (5 test).

- [ ] **Step 5: 옛 modes 테스트 갱신** — `src/agent-layer/orchestrator-modes.spec.ts`

첫 테스트(현 24-36 `'Code 모드 메시지는 classify를 건너뛰고 ... startProposal 한다'`)를 새 동작으로 교체:
```ts
it('Code 모드 메시지는 classify를 건너뛰고 대화 답변으로 간다(answerInCode)', async () => {
  const orch = makeOrchestrator();
  const spyAnswer = jest.spyOn(orch as any, 'answerInCode').mockResolvedValue(undefined);
  const spyClassify = jest.spyOn(orch as any, 'classify');
  await orch.handleMention(
    { text: '로그인 붙여줘', userId: 'c1', mode: 'code', repoPath: 'C:/repo/app' },
    async () => {}, 'c1',
  );
  expect(spyClassify).not.toHaveBeenCalled();
  expect(spyAnswer).toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'code', repoPath: 'C:/repo/app' }), 'c1', expect.any(Function),
  );
});
```
두 번째 테스트(현 38-48 `'repoPath 미바인딩이면 안내만'`)는 `answerInCode`가 폴더 안내를 하므로 그대로 통과 — 단 `spyProposal` 기대를 `answerInCode` 경유 폴더 안내로 조정:
```ts
it('Code 모드인데 repoPath 미바인딩이면 안내만 한다', async () => {
  const orch = makeOrchestrator();
  const posts: string[] = [];
  await orch.handleMention(
    { text: '뭐든', userId: 'c1', mode: 'code' },
    async (t) => { posts.push(t); }, 'c1',
  );
  expect(posts.join('')).toMatch(/폴더|folder/i);
});
```
세 번째 테스트(team escape hatch, 현 50-58)는 무변경 — 벽 아님 유지 확인.

- [ ] **Step 6: modes 테스트 통과 확인**

Run: `npx jest orchestrator-modes --silent`
Expected: PASS (3 test).

- [ ] **Step 7: 전체 orchestrator 스윕 + 빌드**

Run: `npx jest orchestrator --silent` → 전 orchestrator spec PASS
Run: `npm run build` → exit 0

- [ ] **Step 8: 커밋**

```bash
git add src/agent-layer/orchestrator.ts src/agent-layer/orchestrator-code-chat.spec.ts src/agent-layer/orchestrator-modes.spec.ts
git commit -m "feat(orchestrator): [구현 시작] escalate 소비 + Code 모드 대화 전환 테스트 갱신"
```

---

## 남은 것(이 플랜 범위 밖 — 후속)

- **깊은 게이트 출력 컨텍스트**: 지금은 `tracker.status`(running/done/failed)만 주입. "왜 막혔어?"에 마지막 게이트 실패 로그까지 넣으려면 `TaskStore`에서 스레드의 코딩 세션을 찾아 티켓 gate.output을 뽑아야 함. tracker는 in-memory·재시작 소실이라 이 천장은 알려진 것(6b-3). 필요 시 별도 태스크.
- **Ask 채널 무변경**: 이 플랜은 Code 채널만 손댐. Ask/classify는 그대로.
- **지식 코어 MCP 서버**: 스펙 §7 향후 항목. 별도 brainstorming.

## Self-Review

- **스펙 커버리지**: §3 흐름=Task 2·3, §4.1 대화 두뇌 콜(읽기전용·recent·taskStatus)=Task 2, §4.2 마커 파싱=Task 1, §4.3 [구현 시작]·proposeReady=Task 2·3, §5 자율 루프 무변경=손 안 댐(확인만), §6 Ask/classify 무변경=손 안 댐, §8 테스트 관점=각 Task 테스트로 커버. §4.1의 "마지막 게이트 출력"은 축소(위 후속으로 명시).
- **Placeholder**: 없음 — 모든 스텝에 실제 코드/명령/기대 출력.
- **타입 일관성**: `answerInCode(msg, threadKey, post)`·`PendingCode.proposeReady{repoPath,goal}`·`extractPropose→{reply,goal?}`·`buildCodeChatPrompt(instruction, ctx)` — Task 1 정의와 Task 2·3 사용 일치. `channelGate`/`startProposal` 시그니처는 기존 코드에서 확인함.
