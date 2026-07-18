# Phase 8c-1 MCP 클라이언트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 엔그램 하네스 두뇌(anthropic-api·openai-api)가 사용자가 등록한 MCP 서버의 도구를 채팅·코딩 루프에서 쓰게 한다 (공식 SDK, stdio, mcp.json은 Claude Code 포맷 복붙 호환).

**Architecture:** 공식 `@modelcontextprotocol/sdk`의 Client+StdioClientTransport를 얇은 never-throw 래퍼(`McpSession`)로 감싸고, 도구를 `mcp__{서버}__{도구}` 이름으로 기존 `WebToolDef` 배열에 병합·프리픽스 라우팅한다. complete() 단위 lazy 연결→finally 종료. 서버 0개면 회귀 0. 스펙: `docs/superpowers/specs/2026-07-18-phase8c1-mcp-client-design.md`

**Tech Stack:** @modelcontextprotocol/sdk(신규 dep — 스펙 §3.1 예외 사유 있음), TypeScript, Jest(InMemoryTransport 통합 테스트), Electron 설정창.

## Global Constraints

- 명령은 PowerShell. jest 백그라운드 금지(행 걸림) — 포그라운드만. 테스트 `npm test -- --testPathPattern="<이름>"`, 빌드 `npm run build`.
- ★SDK API는 내 서술과 설치본이 다를 수 있다 — 각 태스크는 `node_modules/@modelcontextprotocol/sdk`의 타입 선언을 먼저 확인하고, 다르면 **설치본 기준으로 조정**하되 계약(래퍼 시그니처·never-throw)은 유지.
- 래퍼·도구 실행은 **never-throw**(실패=에러 텍스트 반환) — 웹도구와 동일 계약. 서버 이름은 `[a-z0-9_-]+`만(스펙 §3.6).
- 서버 코드 중 두뇌 2파일·factory 외 무변경(VerificationGate·Orchestrator·CLI 두뇌·PermissionFence 불변). CLI 두뇌 3종 무변경.
- UI 문구 영어 기본+ko. 렌더러 동적 문자열 textContent만. 커밋에 Co-Authored-By 금지.

---

### Task 1: SDK 설치 + mcp-config 로더

**Files:**
- Modify: `package.json` (dep 추가는 npm install로)
- Create: `src/brain/mcp-config.ts`, `src/brain/mcp-config.spec.ts`

**Interfaces:**
- Produces (Task 2~5 사용):

```typescript
export interface McpServerConfig { command: string; args: string[]; env: Record<string, string> }
export function loadMcpServers(configDir: string): Record<string, McpServerConfig>; // 이름 → config, fault-tolerant
export function isValidMcpName(name: string): boolean; // /^[a-z0-9_-]+$/
```

- [ ] **Step 1: SDK 설치** — Run: `npm install @modelcontextprotocol/sdk` / Expected: package.json dependencies에 추가, install clean.
- [ ] **Step 2: 실패하는 테스트 작성** — `src/brain/mcp-config.spec.ts`:

```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadMcpServers, isValidMcpName } from './mcp-config';

describe('mcp-config', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mcp-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const write = (v: unknown) => fs.writeFileSync(path.join(tmp, 'mcp.json'), typeof v === 'string' ? v : JSON.stringify(v));

  it('Claude Code 포맷 파싱: args/env 기본값 채움', () => {
    write({ mcpServers: { gh: { command: 'npx', args: ['-y', 'server-github'] }, fs: { command: 'mcp-fs', env: { ROOT: 'C:\\x' } } } });
    expect(loadMcpServers(tmp)).toEqual({
      gh: { command: 'npx', args: ['-y', 'server-github'], env: {} },
      fs: { command: 'mcp-fs', args: [], env: { ROOT: 'C:\\x' } },
    });
  });
  it('없음/깨짐/형태오류 → {}', () => {
    expect(loadMcpServers(tmp)).toEqual({});
    write('{깨진');
    expect(loadMcpServers(tmp)).toEqual({});
    write({ mcpServers: ['not', 'object'] });
    expect(loadMcpServers(tmp)).toEqual({});
  });
  it('불량 항목 skip: command 없음·빈 문자열·이름 규칙 위반', () => {
    write({ mcpServers: { ok: { command: 'x' }, noCmd: {}, empty: { command: ' ' }, 'Bad Name!': { command: 'y' }, '__proto__': { command: 'z' } } });
    expect(Object.keys(loadMcpServers(tmp))).toEqual(['ok']);
  });
  it('isValidMcpName', () => {
    expect(isValidMcpName('github-mcp_1')).toBe(true);
    expect(isValidMcpName('Bad Name')).toBe(false);
    expect(isValidMcpName('한글')).toBe(false);
    expect(isValidMcpName('')).toBe(false);
  });
});
```

- [ ] **Step 3: 실패 확인** — Run: `npm test -- --testPathPattern="mcp-config"` / Expected: FAIL(모듈 없음).
- [ ] **Step 4: 구현** — `src/brain/mcp-config.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

// MCP 서버 설정(스펙 §3.3) — Claude Code .mcp.json과 동일 포맷(복붙 호환).
export interface McpServerConfig { command: string; args: string[]; env: Record<string, string> }

// 서버 이름은 도구 이름(mcp__{서버}__{도구})에 들어가므로 slug만 허용(프리픽스 파싱 안전, 스펙 §3.6).
export function isValidMcpName(name: string): boolean {
  return /^[a-z0-9_-]+$/.test(name);
}

export function loadMcpServers(configDir: string): Record<string, McpServerConfig> {
  let raw: { mcpServers?: unknown };
  try { raw = JSON.parse(fs.readFileSync(path.join(configDir, 'mcp.json'), 'utf8')); } catch { return {}; }
  const servers = raw?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
  const out: Record<string, McpServerConfig> = {};
  for (const name of Object.keys(servers)) {
    if (!isValidMcpName(name)) continue;
    const s = (servers as Record<string, Record<string, unknown>>)[name];
    if (!s || typeof s !== 'object') continue;
    const command = typeof s.command === 'string' ? s.command.trim() : '';
    if (!command) continue;
    const env: Record<string, string> = {};
    if (s.env && typeof s.env === 'object' && !Array.isArray(s.env)) {
      for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) if (typeof v === 'string') env[k] = v;
    }
    out[name] = {
      command,
      args: Array.isArray(s.args) ? (s.args as unknown[]).filter((a): a is string => typeof a === 'string') : [],
      env,
    };
  }
  return out;
}
```

(주의: `'__proto__'`는 isValidMcpName을 통과하지만(`[a-z0-9_-]+` 매치) `out[name] = …` 브래킷 대입이 조용히 증발시킨다 — **isValidMcpName에서 걸러지지 않으므로 테스트가 요구하는 대로 skip 되려면 정규식으로는 부족**. `if (name === '__proto__' || name === 'constructor' || name === 'prototype') continue;`를 isValidMcpName 안에 넣어라(이 브랜치에서 세 번째 반복되는 함정 — brains-file·coderepos-file 전례). 테스트의 'Bad Name!'과 '__proto__' 둘 다 skip 확인.)

- [ ] **Step 5: 통과 확인** — Run: `npm test -- --testPathPattern="mcp-config"` / Expected: PASS.
- [ ] **Step 6: 커밋** — `git add package.json package-lock.json src/brain/mcp-config.ts src/brain/mcp-config.spec.ts; git commit -m "feat(8c1): 공식 MCP SDK 도입 + mcp.json 로더(Claude Code 포맷 호환·이름 slug 검증)"`

---

### Task 2: McpSession 래퍼 (SDK Client 감싸기)

**Files:**
- Create: `src/brain/mcp-client.ts`, `src/brain/mcp-client.spec.ts`

**Interfaces:**
- Consumes: Task 1 `McpServerConfig`, 기존 `WebToolDef`(web-tools.ts).
- Produces (Task 3 사용):

```typescript
export const MCP_TOOL_PREFIX = 'mcp__';
export class McpSession {
  constructor(name: string, cfg: McpServerConfig);
  connect(): Promise<boolean>;            // 실패 false + logger, throw 안 함
  listToolDefs(): Promise<WebToolDef[]>;  // 이름 mcp__{서버}__{도구}, 실패 []
  owns(toolName: string): boolean;        // mcp__{서버}__ 프리픽스 매치
  callTool(toolName: string, input: unknown, timeoutMs?: number): Promise<string>; // never-throw
  close(): Promise<void>;                 // 멱등
}
```

- [ ] **Step 1: SDK API 확인** — `node_modules/@modelcontextprotocol/sdk` 타입에서 확인: Client 생성자·`connect(transport)`·`listTools()` 반환형(`{tools:[{name,description?,inputSchema}]}` 예상)·`callTool({name, arguments}, …, {timeout})` 옵션·`close()`·`StdioClientTransport({command,args,env})`·`getDefaultEnvironment`(stdio 모듈)·테스트용 `InMemoryTransport.createLinkedPair()`·저수준 `Server`+`ListToolsRequestSchema`/`CallToolRequestSchema`(types 모듈). 다르면 설치본 기준으로 이후 코드 조정(계약 유지).

- [ ] **Step 2: 실패하는 테스트 작성** — InMemoryTransport로 실제 프로토콜 왕복(모킹 없음). 테스트용 서버는 저수준 `Server`+setRequestHandler(zod 직접 의존 회피). 케이스:
  1. connect 성공 → listToolDefs가 `mcp__test__echo` 이름·description·parameters(inputSchema) 매핑
  2. callTool 성공 → content text 항목들 이어붙인 문자열
  3. content에 비텍스트(type:'image') 포함 → `[image]` 표기 삽입
  4. 서버가 isError 응답 → 결과 텍스트에 에러 내용 포함(throw 없음)
  5. callTool 타임아웃(핸들러가 오래 걸림, timeoutMs 짧게) → 에러 텍스트 반환(throw 없음)
  6. 출력 상한: 60k 텍스트 응답 → 50k로 잘리고 절단 표식
  7. close 멱등(2회 호출 무해), close 후 callTool → 에러 텍스트
  8. connect 실패(링크 안 된 transport 또는 즉시 close된 서버) → false

테스트 코드(조정 전제 — Step 1에서 확인한 실제 API로):

```typescript
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpSession } from './mcp-client';

function makeTestServer(behavior: { slow?: boolean; huge?: boolean; isError?: boolean; image?: boolean }): Server {
  const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (behavior.slow) await new Promise((r) => setTimeout(r, 500));
    if (behavior.isError) return { content: [{ type: 'text', text: 'boom' }], isError: true };
    if (behavior.image) return { content: [{ type: 'text', text: 'a' }, { type: 'image', data: '', mimeType: 'image/png' }, { type: 'text', text: 'b' }] };
    const text = behavior.huge ? 'x'.repeat(60_000) : `echo:${(req.params.arguments as { text?: string })?.text ?? ''}`;
    return { content: [{ type: 'text', text }] };
  });
  return server;
}

// McpSession 테스트 진입: 세션이 transport를 내부 생성하는 대신, 테스트 훅(두 번째 인자 or
// createForTest 정적 팩토리)으로 InMemoryTransport 클라측을 주입할 수 있게 구현할 것.
```

(각 케이스: `const [clientT, serverT] = InMemoryTransport.createLinkedPair(); await makeTestServer(...).connect(serverT); const s = McpSession.createForTest('test', clientT); expect(await s.connect()).toBe(true); …`)

- [ ] **Step 3: 실패 확인** — Run: `npm test -- --testPathPattern="mcp-client"` / Expected: FAIL.
- [ ] **Step 4: 구현** — `src/brain/mcp-client.ts` 핵심 구조(설치본 API에 맞춰 조정):

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebToolDef } from './web-tools';
import { McpServerConfig } from './mcp-config';

export const MCP_TOOL_PREFIX = 'mcp__';
const MAX_OUTPUT = 50_000;              // 웹도구와 동일 상한
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

// 공식 SDK Client의 never-throw 래퍼(스펙 §3.2). 실패는 전부 에러 텍스트/false/[]로.
export class McpSession {
  private client: Client | null = null;
  private closed = false;
  private constructor(private readonly name: string, private readonly makeTransport: () => unknown) {}

  static create(name: string, cfg: McpServerConfig): McpSession {
    return new McpSession(name, () => new StdioClientTransport({
      command: cfg.command, args: cfg.args,
      env: { ...getDefaultEnvironment(), ...cfg.env }, // 기본 안전 env(PATH 등) + 사용자 env
    }));
  }
  static createForTest(name: string, transport: unknown): McpSession {
    return new McpSession(name, () => transport);
  }

  async connect(): Promise<boolean> {
    try {
      const c = new Client({ name: 'engram', version: '1.0.0' });
      // ★8b-2 교훈: transport/client가 error 이벤트·onerror 훅을 노출하면 반드시 구독(언핸들드 'error'=호스트 크래시).
      await c.connect(this.makeTransport() as Parameters<Client['connect']>[0]);
      this.client = c;
      return true;
    } catch (e) {
      console.error(`[mcp:${this.name}] connect failed:`, e);
      return false;
    }
  }

  async listToolDefs(): Promise<WebToolDef[]> {
    if (!this.client) return [];
    try {
      const { tools } = await this.client.listTools();
      return tools.map((t) => ({
        name: `${MCP_TOOL_PREFIX}${this.name}__${t.name}`,
        description: t.description ?? '',
        parameters: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      }));
    } catch (e) {
      console.error(`[mcp:${this.name}] listTools failed:`, e);
      return [];
    }
  }

  owns(toolName: string): boolean { return toolName.startsWith(`${MCP_TOOL_PREFIX}${this.name}__`); }

  async callTool(toolName: string, input: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<string> {
    if (!this.client) return `mcp error: ${this.name} not connected`;
    const bare = toolName.slice(`${MCP_TOOL_PREFIX}${this.name}__`.length);
    try {
      const res = await this.client.callTool(
        { name: bare, arguments: (input ?? {}) as Record<string, unknown> },
        undefined,
        { timeout: timeoutMs },
      );
      const parts = Array.isArray(res.content) ? res.content : [];
      let text = parts.map((p: { type?: string; text?: string }) => (p.type === 'text' && typeof p.text === 'string' ? p.text : `[${p.type ?? 'unknown'}]`)).join('\n');
      if (res.isError) text = `tool error: ${text}`;
      if (text.length > MAX_OUTPUT) text = text.slice(0, MAX_OUTPUT) + '\n…(truncated)';
      return text;
    } catch (e) {
      return `mcp error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.client?.close(); } catch { /* 종료 실패 무해 */ }
    this.client = null;
  }
}
```

- [ ] **Step 5: 통과 확인** — Run: `npm test -- --testPathPattern="mcp-client"` / Expected: 8케이스 PASS. `npm run build` clean.
- [ ] **Step 6: 커밋** — `git add src/brain/mcp-client.ts src/brain/mcp-client.spec.ts; git commit -m "feat(8c1): McpSession — SDK Client never-throw 래퍼(InMemory 실프로토콜 테스트 8종)"`

---

### Task 3: 두뇌 배선 — createBrain configDir + 도구 병합·라우팅·finally close

**Files:**
- Modify: `src/brain/brain.factory.ts` (`createBrain(profile, configDir?)` 옵션 인자)
- Modify: `src/brain/anthropic-api.brain.ts`, `src/brain/openai-api.brain.ts` (+각 spec)
- Modify: createBrain 호출부 전부에 configDir 전달 (`grep -rn "createBrain(" src/` — agent-layer.module.ts의 3곳은 `paths.getConfigDir()` 사용, brain-delegator 등 나머지는 해당 파일 맥락의 configDir. 전달 불가능한 호출부는 미전달=MCP 비활성으로 두어도 됨 — 옵션 인자라 하위호환)

**Interfaces:**
- Consumes: Task 1 `loadMcpServers`, Task 2 `McpSession`/`MCP_TOOL_PREFIX`.
- Produces: 두 API 두뇌가 mcp.json 서버의 도구를 채팅·코딩 루프에서 사용. CLI 두뇌·서버 나머지 무변경.

- [ ] **Step 1: 현 구조 파악** — 두 두뇌의 complete()에서 toolDefs 구성부(anthropic-api.brain.ts:44-46 부근)와 executeTool 라우팅부(:48-50 부근), 기존 spec의 두뇌 테스트 패턴(가짜 fetch로 SSE 응답 주입)을 읽는다.
- [ ] **Step 2: 실패하는 테스트 작성** — 각 두뇌 spec에 추가(기존 패턴 재사용, McpSession은 jest.mock으로 대체 — 여기서는 두뇌의 병합·라우팅·수명만 검증, 프로토콜은 Task 2가 커버):
  1. configDir 미전달 또는 mcp.json 없음 → toolDefs에 mcp__ 없음(기존 테스트 전부 그대로 통과 = 회귀 0)
  2. 서버 1개 연결 성공 → 채팅 toolDefs 끝에 mcp__ 도구 추가, 모델이 그 도구 호출 시 해당 세션 callTool로 라우팅되고 결과가 tool result로 되먹임
  3. connect false인 서버 → 제외(그 서버 도구 없음), 나머지 정상
  4. complete 정상 종료·에러 종료 모두에서 세션 close 호출(finally)
  5. 코딩 루프(opts.cwd)에서도 동일 병합
- [ ] **Step 3: 실패 확인** — Run: `npm test -- --testPathPattern="anthropic-api|openai-api"` / Expected: 신규 케이스 FAIL.
- [ ] **Step 4: 구현** — 패턴(두 두뇌 동일):

```typescript
// complete() 진입부(기존 toolDefs 구성 직후):
const mcpSessions: McpSession[] = [];
if (this.configDir) {
  for (const [name, cfg] of Object.entries(loadMcpServers(this.configDir))) {
    const s = McpSession.create(name, cfg);
    if (await s.connect()) mcpSessions.push(s); else await s.close();
  }
  for (const s of mcpSessions) toolDefs.push(...(await s.listToolDefs()));
}
// executeTool 라우팅(기존 분기 앞):
if (name.startsWith(MCP_TOOL_PREFIX)) {
  const s = mcpSessions.find((x) => x.owns(name));
  return s ? s.callTool(name, input, ctrl.signal ? undefined : undefined) : `mcp error: unknown tool ${name}`;
}
// 반환 경로 전체를 try/finally로 감싸고 finally에서:
await Promise.all(mcpSessions.map((s) => s.close()));
```

(정확한 삽입 위치·기존 구조 보존은 구현자가 파일 읽고 판단. abort(ctrl.signal)와의 상호작용: 루프 타임아웃 시 finally가 close를 보장하면 충분 — callTool 자체는 SDK timeout이 건다.)

factory: `export function createBrain(profile: BrainProfile, configDir?: string)` — 두 API 두뇌 생성자에 전달, CLI 두뇌는 무시. 호출부 grep 후 전부 전달.

- [ ] **Step 5: 통과 확인** — Run: `npm test` 전체 / Expected: 전부 PASS(기존 포함). `npm run build` clean.
- [ ] **Step 6: 커밋** — `git add -A src/brain src/agent-layer; git commit -m "feat(8c1): 두뇌 MCP 배선 — createBrain configDir·도구 병합(mcp__ 프리픽스)·finally close·회귀 0"`

---

### Task 4: desktop mcp-file + IPC + preload

**Files:**
- Create: `src/desktop/mcp-file.ts`, `src/desktop/mcp-file.spec.ts`
- Modify: `src/desktop/main.ts`, `src/desktop/preload.ts`

**Interfaces:**
- Produces (Task 5 사용): `window.engram.listMcpServers()` → `Array<{name, command, args}>`, `addMcpServer(name, command, argsLine)→boolean`(이름 불량/충돌/빈 command=false; argsLine은 공백 분리), `removeMcpServer(name)`.

- [ ] **Step 1: 실패하는 테스트 작성** — `mcp-file.spec.ts`(brains-file 스타일):

```typescript
import { listMcpServersFile, addMcpServer, removeMcpServer } from './mcp-file';
// fs/os/path import 동일 스타일

describe('mcp-file', () => {
  // tmp beforeEach/afterEach 동일 패턴
  it('add: 파일 생성+Claude Code 포맷, argsLine 공백분리, 재로드로 확인', () => {
    expect(addMcpServer(tmp, 'everything', 'npx', '-y @modelcontextprotocol/server-everything')).toBe(true);
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf8'));
    expect(raw.mcpServers.everything).toEqual({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] });
    expect(listMcpServersFile(tmp)).toEqual([{ name: 'everything', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] }]);
  });
  it('add 거부: 이름 규칙 위반·이름 충돌·빈 command → false·무변경', () => {
    expect(addMcpServer(tmp, 'Bad Name', 'x', '')).toBe(false);
    expect(addMcpServer(tmp, 'a', ' ', '')).toBe(false);
    addMcpServer(tmp, 'a', 'x', '');
    expect(addMcpServer(tmp, 'a', 'y', '')).toBe(false);
    expect(listMcpServersFile(tmp)[0].command).toBe('x');
  });
  it('remove 멱등 + 다른 항목·기존 파일 필드 보존', () => {
    fs.writeFileSync(path.join(tmp, 'mcp.json'), JSON.stringify({ somethingElse: 1, mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }));
    removeMcpServer(tmp, 'a');
    removeMcpServer(tmp, 'a');
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf8'));
    expect(raw.mcpServers).toEqual({ b: { command: 'y' } });
    expect(raw.somethingElse).toBe(1);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm test -- --testPathPattern="mcp-file"` / Expected: FAIL.
- [ ] **Step 3: 구현** — `mcp-file.ts`: brains-file 결. `isValidMcpName`은 `../brain/mcp-config`에서 import(로직 한 곳). add: 파일 읽기(fault-tolerant, 골격 `{mcpServers:{}}`)→검증(false 사유: 이름 불량[hasOwnProperty로 충돌 검사 — `in` 금지, 이 브랜치 전례]·충돌·빈 command)→`Object.defineProperty`로 own property 대입(__proto__ 전례)→저장(다른 최상위 필드 보존). argsLine: `argsLine.trim() ? argsLine.trim().split(/\s+/) : []`. args 빈 배열이면 JSON에 args 키 생략(Claude Code 포맷 관례). remove: hasOwnProperty 없으면 no-op.
- [ ] **Step 4: IPC+preload** — main.ts registerIpc(기존 결): `engram:list-mcp-servers`/`engram:add-mcp-server`/`engram:remove-mcp-server` → 위 함수 위임. preload 1:1(`listMcpServers`/`addMcpServer`/`removeMcpServer`).
- [ ] **Step 5: 통과 확인** — Run: `npm test -- --testPathPattern="desktop"` PASS + `npm run build` clean.
- [ ] **Step 6: 커밋** — `git add src/desktop/mcp-file.ts src/desktop/mcp-file.spec.ts src/desktop/main.ts src/desktop/preload.ts; git commit -m "feat(8c1): mcp.json desktop 함수+IPC 3종(이름 검증·충돌 거부·타 필드 보존)"`

---

### Task 5: 설정창 MCP 섹션 + 실스모크 체크리스트

**Files:**
- Modify: `src/desktop/settings.html`

**Interfaces:**
- Consumes: Task 4 preload 3종. 기존 인셋 문법(.grp/.li/.minus/.add-row/.cap, 섹션·SECTION_LABELS·i18n 구조 — Brain/Coding 섹션이 참조 구현).

- [ ] **Step 1: 사이드바+섹션** — nav에 MCP 항목 추가(타일 색 `#0F6E56` 계열 미사용 색, 인라인 SVG 글리프: 플러그 모양 — 원 2개+선 또는 단순 소켓, 기존 8종과 같은 stroke 문법). `<section id="sec-mcp"><h2>MCP</h2></section>`(h2는 고유명사라 양 로케일 'MCP' — data-t 불필요). 위치: Wiki sync 다음.
- [ ] **Step 2: 목록+추가 폼** — 서버 그룹: 줄 = ⊖ + 이름(mono) + `command args...` 요약(muted, ellipsis). ＋ 추가 줄 → 인라인 폼(이름 input[placeholder 'github'], command input[placeholder 'npx'], args input[placeholder '-y @modelcontextprotocol/server-github'], Cancel/Add). `addMcpServer` false → t.nameConflict 재사용 표시(이름 불량도 같은 문구면 어색하므로 신규 t.mcpNameRule 사용 — 아래 i18n). 성공 → 목록 재로드 + 재시작 힌트(#mcp-hint, cap ok 패턴 — 렌더 시작 시 hide). 빈 목록 → t.mcpEmpty 줄.
- [ ] **Step 3: i18n** — ko: `mcpCap: 'AI에 도구를 꽂는 표준(MCP) 서버 목록 — Claude Code의 .mcp.json과 같은 포맷이라 파일을 직접 편집해도 돼요', mcpEmpty: '등록된 MCP 서버가 없어요', mcpNameRule: '이름은 영소문자·숫자·-·_만, 중복 불가', addServer: '서버 추가'` / en: `mcpCap: 'MCP servers — the standard way to plug tools into AI. Same format as Claude Code\\'s .mcp.json, so editing the file directly works too', mcpEmpty: 'No MCP servers', mcpNameRule: 'Lowercase letters, digits, - and _ only; no duplicates', addServer: 'Add server'`. SECTION_LABELS['sec-mcp'] = ['MCP', t.addServer, …].
- [ ] **Step 4: 검증** — `npm run build` clean → `npm test` 전체 PASS. **실스모크 체크리스트**(가능 시 computer-use, 불가 시 미검증 보고): ①설정창 MCP 섹션에서 `everything` / `npx` / `-y @modelcontextprotocol/server-everything` 추가 → mcp.json 확인 ②재시작 후 채팅에서 엔그램 하네스 두뇌로 "echo 도구로 hello 출력해봐" → mcp__everything__echo 호출 왕복 ③서버 제거 → 파일 반영. (②는 API 키/올라마 모델 필요 — 없으면 ①③만.)
- [ ] **Step 5: 커밋** — `git add src/desktop/settings.html; git commit -m "feat(8c1): 설정창 MCP 섹션 — 서버 목록·추가·삭제(인셋 문법·검색 인덱스 포함)"`

---

## Self-Review 결과

- 스펙 커버리지: §3.1→Task 1(Step 1), §3.2→Task 2, §3.3→Task 1, §3.4→Task 3, §3.5→Task 4+5, §3.6→Task 1(이름 검증)+4(add 거부), §4→각 태스크 테스트+Task 5 스모크. 갭 없음.
- 시그니처 일관성: `McpServerConfig`/`loadMcpServers`/`isValidMcpName`(1↔2↔4), `McpSession.create/createForTest/connect/listToolDefs/owns/callTool/close`(2↔3), preload 3종(4↔5) 대조 완료.
- SDK API 불확실성은 Global Constraints+Task 2 Step 1로 명시 처리(설치본 타입이 소스 오브 트루스).
- `__proto__` 계열 함정: Task 1 구현 주의문+Task 4 defineProperty/hasOwnProperty 명시(이 브랜치에서 세 번 적발된 클래스).
