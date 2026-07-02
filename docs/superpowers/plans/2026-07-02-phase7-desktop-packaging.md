# Phase 7 배포·패키징 (Electron 설치형 데스크톱 앱) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Engram을 트레이 상주 + 설정창을 가진 더블클릭 설치형 데스크톱 앱(Win NSIS/Mac dmg/Linux AppImage)으로 포장한다.

**Architecture:** Electron 메인 프로세스(`src/desktop/`)가 트레이·설정창·자동시작을 담당하고, 기존 상주(`dist/src/main.js`)를 `utilityProcess.fork` 자식으로 품어 감독(크래시 백오프 재시작)한다. 데이터 위치는 자식에 `ENGRAM_DATA_DIR=app.getPath('userData')` env를 넘기는 것으로 전환(PathResolver가 이미 지원). 코어 수정은 소형 2건(리소스 오버라이드, 임베딩 캐시 경로)뿐.

**Tech Stack:** Electron(신규 devDep), electron-builder(신규 devDep), 기존 NestJS/jest/ts-jest. 프로덕션 dep 추가 0.

**스펙:** `docs/superpowers/specs/2026-07-02-phase7-desktop-packaging-design.md`

## Global Constraints

- 셸은 PowerShell (이 머신 Bash 훅 깨짐). 명령 예시는 PowerShell 기준.
- 코어(Orchestrator/에이전트/지식) 무변경 원칙 — 허용된 코어 수정은 Task 1~3의 소형 2건(+공유 헬퍼)뿐.
- Electron 코드는 `src/desktop/` — jest(rootDir=src)·nest build(tsc)가 그대로 집어감. jest.config.js·tsconfig.json 수정 금지.
- 순수 로직은 전부 의존성 주입(runner/fetch/now)으로 단위테스트. Electron API(트레이·창)는 단위테스트 안 함 — 수동 스모크(스펙 §8).
- 커밋 메시지에 공동 작업자(Co-Authored-By) 넣지 않는다.
- 문서·주석·UI 문구는 자연스러운 한국어.
- 테스트 실행: `npx jest src/<파일>.spec.ts` (전체는 `npm test`). 임베더 통합테스트는 opt-in이므로 건드리지 않는다.
- 새 프로덕션 dependency 추가 금지. devDependencies는 electron·electron-builder 2개만 허용.

---

### Task 1: 번들 리소스 해소 헬퍼 `resource-dir`

**Files:**
- Create: `src/pal/resource-dir.ts`
- Test: `src/pal/resource-dir.spec.ts`

**Interfaces:**
- Consumes: `findRepoRoot(startDir: string): string` (`src/pal/repo-root.ts`, 기존)
- Produces:
  - `resolveResourceFile(relPath: string, env?: NodeJS.ProcessEnv): string` — `env.ENGRAM_DATA_DIR/relPath`가 존재하면 그 경로, 아니면 `<repoRoot>/relPath`. (파일 단위 오버라이드 — prompts용)
  - `resolveResourceDir(name: string, env?: NodeJS.ProcessEnv): string` — `env.ENGRAM_DATA_DIR/name` 디렉토리가 존재하면 그 경로, 아니면 `<repoRoot>/name`. (폴더 통째 오버라이드 — personas용)

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// src/pal/resource-dir.spec.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveResourceFile, resolveResourceDir } from './resource-dir';
import { findRepoRoot } from './repo-root';

describe('resource-dir', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-res-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('ENGRAM_DATA_DIR에 파일이 있으면 그 경로를 반환한다', () => {
    fs.mkdirSync(path.join(tmp, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'prompts', 'triage.md'), '오버라이드');
    const p = resolveResourceFile('prompts/triage.md', { ENGRAM_DATA_DIR: tmp });
    expect(p).toBe(path.join(tmp, 'prompts', 'triage.md'));
  });

  it('ENGRAM_DATA_DIR에 파일이 없으면 레포 루트로 폴백한다', () => {
    const p = resolveResourceFile('prompts/triage.md', { ENGRAM_DATA_DIR: tmp });
    expect(p).toBe(path.join(findRepoRoot(__dirname), 'prompts', 'triage.md'));
  });

  it('ENGRAM_DATA_DIR 미설정이면 레포 루트를 쓴다', () => {
    const p = resolveResourceFile('prompts/triage.md', {});
    expect(p).toBe(path.join(findRepoRoot(__dirname), 'prompts', 'triage.md'));
  });

  it('디렉토리 오버라이드: dataDir/personas가 있으면 그 폴더', () => {
    fs.mkdirSync(path.join(tmp, 'personas'), { recursive: true });
    expect(resolveResourceDir('personas', { ENGRAM_DATA_DIR: tmp })).toBe(path.join(tmp, 'personas'));
  });

  it('디렉토리 오버라이드: 없으면 레포 루트 폴백', () => {
    expect(resolveResourceDir('personas', { ENGRAM_DATA_DIR: tmp })).toBe(
      path.join(findRepoRoot(__dirname), 'personas'),
    );
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/pal/resource-dir.spec.ts`
Expected: FAIL — `Cannot find module './resource-dir'`

- [ ] **Step 3: 최소 구현**

```typescript
// src/pal/resource-dir.ts
import * as fs from 'fs';
import * as path from 'path';
import { findRepoRoot } from './repo-root';

// 번들 리소스(prompts/·personas/)의 사용자 편집 오버라이드(스펙 §3).
// 데이터 폴더(ENGRAM_DATA_DIR)에 같은 이름이 있으면 그것을, 없으면 앱/레포 루트의 번들본을 쓴다.
// 설치형 앱에서 findRepoRoot는 앱 패키지 루트(package.json 위치)를 가리키므로 번들본이 폴백이 된다.

// 파일 단위 오버라이드(프롬프트 하나만 고쳐도 나머지는 번들본 유지).
export function resolveResourceFile(relPath: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.ENGRAM_DATA_DIR) {
    const p = path.join(env.ENGRAM_DATA_DIR, relPath);
    if (fs.existsSync(p)) return p;
  }
  return path.join(findRepoRoot(__dirname), relPath);
}

// 폴더 통째 오버라이드(personas는 레지스트리가 디렉토리 전체를 스캔하므로 폴더 단위).
export function resolveResourceDir(name: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.ENGRAM_DATA_DIR) {
    const p = path.join(env.ENGRAM_DATA_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(findRepoRoot(__dirname), name);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/pal/resource-dir.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```powershell
git add src/pal/resource-dir.ts src/pal/resource-dir.spec.ts
git commit -m "feat(phase7): resource-dir — 번들 리소스의 dataDir 오버라이드 해소 헬퍼"
```

---

### Task 2: 프롬프트·페르소나 로더에 오버라이드 배선

**Files:**
- Modify: `src/agent-layer/prompt-store.ts` (10행: `findRepoRoot` 경로 조립 → `resolveResourceFile`)
- Modify: `src/agent-layer/agent-layer.module.ts` (43행: personasDir 조립 → `resolveResourceDir`)
- Test: `src/agent-layer/prompt-store.spec.ts` (기존 파일 있으면 추가, 없으면 생성)

**Interfaces:**
- Consumes: Task 1의 `resolveResourceFile`/`resolveResourceDir`
- Produces: `loadPrompt(name, fallback)` 동작 확장 — `ENGRAM_DATA_DIR/prompts/{name}.md`가 있으면 우선. 시그니처 무변경(호출부 무영향).

- [ ] **Step 1: 실패하는 테스트 작성** (기존 `src/agent-layer/prompt-store.spec.ts`가 있으면 describe 블록만 추가)

```typescript
// src/agent-layer/prompt-store.spec.ts 에 추가
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadPrompt } from './prompt-store';

describe('loadPrompt dataDir 오버라이드 (Phase 7)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-prompt-'));
    process.env.ENGRAM_DATA_DIR = tmp;
  });
  afterEach(() => {
    delete process.env.ENGRAM_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('dataDir/prompts에 같은 이름이 있으면 그것을 읽는다', () => {
    fs.mkdirSync(path.join(tmp, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'prompts', 'phase7-test.md'), '사용자 편집본');
    expect(loadPrompt('phase7-test', '기본값')).toBe('사용자 편집본');
  });

  it('dataDir에 없으면 기존 동작(레포 번들→fallback)', () => {
    expect(loadPrompt('phase7-없는프롬프트', '기본값')).toBe('기본값');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/agent-layer/prompt-store.spec.ts`
Expected: 첫 테스트 FAIL — 오버라이드 파일 대신 '기본값' 반환 (레포에 phase7-test.md가 없으므로)

- [ ] **Step 3: 구현 — loadPrompt 한 줄 교체**

```typescript
// src/agent-layer/prompt-store.ts — 전체 교체
import * as fs from 'fs';
import { resolveResourceFile } from '../pal/resource-dir';

// 편집 가능한 에이전트 지시문을 prompts/{name}.md에서 읽는다(코드 수정·재빌드 없이 튜닝).
// 파일 없음/비어있음 → fallback(내장 기본값)으로 out-of-box 동작 보장. personas/*.md와 같은 결.
// Phase 7: 데이터 폴더(ENGRAM_DATA_DIR)/prompts에 같은 이름이 있으면 사용자 편집본 우선.
// JSON 출력 계약 등 파서와 묶인 줄은 호출부가 코드에서 덧붙인다(사용자가 못 깨게).
export function loadPrompt(name: string, fallback: string): string {
  try {
    const p = resolveResourceFile(`prompts/${name}.md`);
    const text = fs.readFileSync(p, 'utf8').trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}
```

그리고 `src/agent-layer/agent-layer.module.ts`의 PersonaRegistry 팩토리(43행 근처)를 교체:

```typescript
// 변경 전:
//   const personasDir = path.join(findRepoRoot(__dirname), 'personas');
// 변경 후 (import { resolveResourceDir } from '../pal/resource-dir'; 추가):
const personasDir = resolveResourceDir('personas');
```

주의: `findRepoRoot` import는 PermissionFence 팩토리(53행)가 계속 쓰므로 지우지 말 것.
`path` import도 다른 곳에서 쓰면 유지.

- [ ] **Step 4: 통과 + 회귀 확인**

Run: `npx jest src/agent-layer/prompt-store.spec.ts; npx jest src/agent-layer`
Expected: PASS (agent-layer 전체 회귀 포함 — persona 관련 기존 테스트가 깨지지 않아야 함)

- [ ] **Step 5: 커밋**

```powershell
git add src/agent-layer/prompt-store.ts src/agent-layer/prompt-store.spec.ts src/agent-layer/agent-layer.module.ts
git commit -m "feat(phase7): 프롬프트·페르소나 로더 dataDir 오버라이드(설치형 사용자 편집본 우선)"
```

---

### Task 3: 임베딩 캐시 경로 env — `ENGRAM_MODEL_CACHE_DIR`

**Files:**
- Modify: `src/knowledge-core/rag/transformers-embedder.ts`
- Test: `src/knowledge-core/rag/transformers-embedder-cache.spec.ts` (신규 — 기존 spec은 opt-in 통합테스트라 건드리지 않음)

**Interfaces:**
- Produces: `applyModelCacheDir(tfEnv: { cacheDir?: string }, env?: NodeJS.ProcessEnv): void` — export된 순수 함수. `ENGRAM_MODEL_CACHE_DIR` 설정 시 transformers.js `env.cacheDir`를 덮어씀(미설정 시 no-op).

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// src/knowledge-core/rag/transformers-embedder-cache.spec.ts
import { applyModelCacheDir } from './transformers-embedder';

describe('applyModelCacheDir', () => {
  it('ENGRAM_MODEL_CACHE_DIR가 있으면 cacheDir를 덮어쓴다', () => {
    const tfEnv: { cacheDir?: string } = { cacheDir: '/원래값' };
    applyModelCacheDir(tfEnv, { ENGRAM_MODEL_CACHE_DIR: 'C:\\data\\models' });
    expect(tfEnv.cacheDir).toBe('C:\\data\\models');
  });

  it('미설정이면 건드리지 않는다(개발 모드 무변경)', () => {
    const tfEnv: { cacheDir?: string } = { cacheDir: '/원래값' };
    applyModelCacheDir(tfEnv, {});
    expect(tfEnv.cacheDir).toBe('/원래값');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/knowledge-core/rag/transformers-embedder-cache.spec.ts`
Expected: FAIL — `applyModelCacheDir` export 없음

- [ ] **Step 3: 구현**

`src/knowledge-core/rag/transformers-embedder.ts`에 export 함수 추가 + `pipe()`에서 호출:

```typescript
// transformers.js의 캐시 위치는 OS env가 아니라 JS 설정(env.cacheDir)이라 스스로 읽지 않는다.
// 설치형 앱(Electron)이 ENGRAM_MODEL_CACHE_DIR로 데이터 폴더를 지정하는 통로(스펙 §5). 미설정=기존 기본 캐시.
export function applyModelCacheDir(
  tfEnv: { cacheDir?: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.ENGRAM_MODEL_CACHE_DIR) tfEnv.cacheDir = env.ENGRAM_MODEL_CACHE_DIR;
}
```

`pipe()` 내부 변경(기존 16~23행):

```typescript
  private async pipe(): Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> {
    if (!this.extractor) {
      const mod = await dynamicImport('@huggingface/transformers');
      applyModelCacheDir(mod.env);
      this.extractor = await mod.pipeline('feature-extraction', this.modelId);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.extractor!;
  }
```

- [ ] **Step 4: 통과 + 빌드 확인**

Run: `npx jest src/knowledge-core/rag/transformers-embedder-cache.spec.ts; npx tsc --noEmit`
Expected: PASS + 타입 클린

- [ ] **Step 5: 커밋**

```powershell
git add src/knowledge-core/rag/transformers-embedder.ts src/knowledge-core/rag/transformers-embedder-cache.spec.ts
git commit -m "feat(phase7): 임베딩 모델 캐시 경로 ENGRAM_MODEL_CACHE_DIR 지원"
```

---

### Task 4: 데스크톱 상태 판정 `src/desktop/status.ts`

**Files:**
- Create: `src/desktop/status.ts`
- Test: `src/desktop/status.spec.ts`

**Interfaces:**
- Consumes: `readHeartbeat(filePath): number | null`, `isStale(now, lastBeat, staleMs): boolean` (`src/pal/watchdog-core.ts`, 기존 — 신규 IPC 대신 heartbeat 파일 재사용이 스펙 §4의 핵심)
- Produces: `readStatus(dataDir: string, now: number): DesktopStatus` — `{ alive: boolean; lastBeat: number | null; modelCacheReady: boolean }`

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// src/desktop/status.spec.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readStatus } from './status';

describe('readStatus', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-status-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeBeat(epochMs: number): void {
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'state', 'heartbeat'), String(epochMs));
  }

  it('최근 박동(3분 이내)이면 alive', () => {
    writeBeat(1_000_000);
    expect(readStatus(tmp, 1_000_000 + 60_000)).toMatchObject({ alive: true, lastBeat: 1_000_000 });
  });

  it('박동이 3분 넘게 오래되면 죽음', () => {
    writeBeat(1_000_000);
    expect(readStatus(tmp, 1_000_000 + 4 * 60_000).alive).toBe(false);
  });

  it('heartbeat 파일이 없으면 죽음 취급(lastBeat null)', () => {
    expect(readStatus(tmp, 1_000_000)).toMatchObject({ alive: false, lastBeat: null });
  });

  it('models 폴더에 내용이 있으면 modelCacheReady', () => {
    fs.mkdirSync(path.join(tmp, 'models', 'Xenova'), { recursive: true });
    expect(readStatus(tmp, 0).modelCacheReady).toBe(true);
  });

  it('models 폴더가 없거나 비면 미준비', () => {
    expect(readStatus(tmp, 0).modelCacheReady).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/desktop/status.spec.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```typescript
// src/desktop/status.ts
import * as fs from 'fs';
import * as path from 'path';
import { readHeartbeat, isStale } from '../pal/watchdog-core';

// 설정창 상태 표시용 판정(스펙 §4). 신규 IPC 없이 기존 heartbeat 파일(mtime 아닌 내용=epoch ms)을 재사용한다.
export interface DesktopStatus {
  alive: boolean;
  lastBeat: number | null;
  modelCacheReady: boolean;
}

// heartbeat 주기(60초)의 3배를 생존 한계로 본다.
const STALE_MS = 3 * 60_000;

export function readStatus(dataDir: string, now: number): DesktopStatus {
  const lastBeat = readHeartbeat(path.join(dataDir, 'state', 'heartbeat'));
  // watchdog의 isStale은 부팅 유예로 null→false지만, 표시용은 박동 없음=죽음으로 본다.
  const alive = lastBeat !== null && !isStale(now, lastBeat, STALE_MS);
  let modelCacheReady = false;
  try {
    modelCacheReady = fs.readdirSync(path.join(dataDir, 'models')).length > 0;
  } catch {
    // 폴더 없음 = 미준비
  }
  return { alive, lastBeat, modelCacheReady };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/desktop/status.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```powershell
git add src/desktop/status.ts src/desktop/status.spec.ts
git commit -m "feat(phase7): 데스크톱 상태 판정 — heartbeat 재사용 + 모델 캐시 확인"
```

---

### Task 5: 크래시 백오프 `src/desktop/backoff.ts`

**Files:**
- Create: `src/desktop/backoff.ts`
- Test: `src/desktop/backoff.spec.ts`

**Interfaces:**
- Produces: `class Backoff { next(): number; reset(): void; get consecutiveFails(): number }` — 재시작 지연 5초→30초→5분(이후 5분 고정). `STABLE_UPTIME_MS = 60_000` (자식이 이만큼 살아있었으면 reset). `WARN_AFTER = 3` (연속 실패 이만큼이면 트레이 경고).

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// src/desktop/backoff.spec.ts
import { Backoff, STABLE_UPTIME_MS, WARN_AFTER } from './backoff';

describe('Backoff', () => {
  it('5초→30초→5분→5분 순으로 지연을 늘린다', () => {
    const b = new Backoff();
    expect(b.next()).toBe(5_000);
    expect(b.next()).toBe(30_000);
    expect(b.next()).toBe(300_000);
    expect(b.next()).toBe(300_000); // 최댓값 고정
  });

  it('reset하면 처음(5초)부터 다시', () => {
    const b = new Backoff();
    b.next();
    b.next();
    b.reset();
    expect(b.next()).toBe(5_000);
  });

  it('consecutiveFails는 next 횟수를 센다', () => {
    const b = new Backoff();
    b.next();
    b.next();
    expect(b.consecutiveFails).toBe(2);
    b.reset();
    expect(b.consecutiveFails).toBe(0);
  });

  it('상수: 1분 생존이면 안정, 3연속 실패면 경고', () => {
    expect(STABLE_UPTIME_MS).toBe(60_000);
    expect(WARN_AFTER).toBe(3);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/desktop/backoff.spec.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```typescript
// src/desktop/backoff.ts
// 자식(상주) 크래시 재시작 백오프(스펙 §7): 5초 → 30초 → 5분, 이후 5분 고정.
const STEPS = [5_000, 30_000, 300_000];

// 자식이 이 시간 이상 살아있었으면 "안정"으로 보고 백오프를 리셋한다.
export const STABLE_UPTIME_MS = 60_000;

// 연속 실패가 이 횟수에 달하면 트레이 아이콘을 경고 상태로 바꾼다.
export const WARN_AFTER = 3;

export class Backoff {
  private fails = 0;

  next(): number {
    const delay = STEPS[Math.min(this.fails, STEPS.length - 1)];
    this.fails++;
    return delay;
  }

  reset(): void {
    this.fails = 0;
  }

  get consecutiveFails(): number {
    return this.fails;
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/desktop/backoff.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```powershell
git add src/desktop/backoff.ts src/desktop/backoff.spec.ts
git commit -m "feat(phase7): 자식 재시작 백오프(5초-30초-5분)"
```

---

### Task 6: claude CLI 감지 `src/desktop/claude-detect.ts`

**Files:**
- Create: `src/desktop/claude-detect.ts`
- Test: `src/desktop/claude-detect.spec.ts`

**Interfaces:**
- Produces:
  - `type Runner = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string }>`
  - `detectClaude(run: Runner): Promise<{ installed: boolean; version: string | null }>`
  - `claudeInstallCommand(platform: NodeJS.Platform): string` — 설치 안내 명령(win32=PowerShell, 그 외=curl)
  - `spawnRunner: Runner` — cross-spawn 기반 실제 러너(Electron 메인이 사용)

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// src/desktop/claude-detect.spec.ts
import { detectClaude, claudeInstallCommand, Runner } from './claude-detect';

describe('detectClaude', () => {
  it('종료코드 0이면 설치됨 + 버전 문자열', async () => {
    const run: Runner = async () => ({ code: 0, stdout: '1.2.3 (Claude Code)\n' });
    expect(await detectClaude(run)).toEqual({ installed: true, version: '1.2.3 (Claude Code)' });
  });

  it('종료코드 비0이면 미설치', async () => {
    const run: Runner = async () => ({ code: 1, stdout: '' });
    expect(await detectClaude(run)).toEqual({ installed: false, version: null });
  });

  it('spawn 자체가 throw(ENOENT)해도 미설치로 강등', async () => {
    const run: Runner = async () => {
      throw new Error('ENOENT');
    };
    expect(await detectClaude(run)).toEqual({ installed: false, version: null });
  });

  it('설치 명령: win32=PowerShell, 그 외=curl', () => {
    expect(claudeInstallCommand('win32')).toBe('irm https://claude.ai/install.ps1 | iex');
    expect(claudeInstallCommand('darwin')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(claudeInstallCommand('linux')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/desktop/claude-detect.spec.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```typescript
// src/desktop/claude-detect.ts
import spawn = require('cross-spawn');

// claude CLI 설치 감지(스펙 §4 두뇌 연결). 로그인 여부는 실 API 콜 비용 때문에 감지하지 않는다.
export type Runner = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;

export async function detectClaude(run: Runner): Promise<{ installed: boolean; version: string | null }> {
  try {
    const r = await run('claude', ['--version']);
    if (r.code === 0) return { installed: true, version: r.stdout.trim() || null };
  } catch {
    // ENOENT 등 = 미설치
  }
  return { installed: false, version: null };
}

// 공식 설치 명령(DESIGN.md §12) — 설정창의 "복사" 버튼 내용.
export function claudeInstallCommand(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash';
}

// 실제 러너(Electron 메인 전용). 테스트는 가짜 Runner를 주입한다.
export const spawnRunner: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/desktop/claude-detect.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```powershell
git add src/desktop/claude-detect.ts src/desktop/claude-detect.spec.ts
git commit -m "feat(phase7): claude CLI 설치 감지 + 공식 설치 명령 안내"
```

---

### Task 7: Ollama 감지·프로필 작성 `src/desktop/ollama.ts`

**Files:**
- Create: `src/desktop/ollama.ts`
- Test: `src/desktop/ollama.spec.ts`

**Interfaces:**
- Consumes: brains.json 스키마 — `{ default: string, brains: Record<string, Partial<BrainProfile>> }`, BrainProfile 키 `provider/cli/model/concurrency/timeoutMs/extraArgs/env` (`src/brain/brain.config.ts`). provider 허용값은 `claude-cli`뿐(로컬LLM은 env 교체로 흡수 — Phase 3 구조).
- Produces:
  - `detectOllama(fetchFn?: typeof fetch, baseUrl?: string): Promise<{ running: boolean; models: string[] }>` — GET `{baseUrl}/api/tags`
  - `addOllamaProfile(configDir: string, model: string, setDefault?: boolean): void` — brains.json에 `ollama` 프로필 병합 저장(다른 프로필 보존)

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// src/desktop/ollama.spec.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectOllama, addOllamaProfile } from './ollama';

describe('detectOllama', () => {
  it('응답 OK면 running + 모델 이름 목록', async () => {
    const fetchFn = (async () => ({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3.3:latest' }, { name: 'qwen3:8b' }] }),
    })) as unknown as typeof fetch;
    expect(await detectOllama(fetchFn)).toEqual({ running: true, models: ['llama3.3:latest', 'qwen3:8b'] });
  });

  it('연결 실패(throw)면 running=false', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await detectOllama(fetchFn)).toEqual({ running: false, models: [] });
  });

  it('비정상 응답(ok=false)도 running=false', async () => {
    const fetchFn = (async () => ({ ok: false })) as unknown as typeof fetch;
    expect(await detectOllama(fetchFn)).toEqual({ running: false, models: [] });
  });
});

describe('addOllamaProfile', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ollama-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function readBrains(): any {
    return JSON.parse(fs.readFileSync(path.join(tmp, 'brains.json'), 'utf8'));
  }

  it('brains.json이 없으면 만들고 ollama 프로필을 넣는다(default는 claude 유지)', () => {
    addOllamaProfile(tmp, 'llama3.3:latest');
    const cfg = readBrains();
    expect(cfg.brains.ollama).toEqual({
      provider: 'claude-cli',
      cli: 'claude',
      model: 'llama3.3:latest',
      env: { ANTHROPIC_BASE_URL: 'http://localhost:11434' },
    });
    expect(cfg.default).toBe('claude');
  });

  it('기존 프로필을 보존하고 ollama만 병합한다', () => {
    fs.writeFileSync(
      path.join(tmp, 'brains.json'),
      JSON.stringify({ default: 'claude', brains: { claude: { model: 'opus' }, judge: {} } }),
    );
    addOllamaProfile(tmp, 'qwen3:8b');
    const cfg = readBrains();
    expect(cfg.brains.claude).toEqual({ model: 'opus' });
    expect(cfg.brains.judge).toEqual({});
    expect(cfg.brains.ollama.model).toBe('qwen3:8b');
  });

  it('setDefault=true면 default를 ollama로 바꾼다', () => {
    addOllamaProfile(tmp, 'qwen3:8b', true);
    expect(readBrains().default).toBe('ollama');
  });

  it('깨진 brains.json이면 기본 골격으로 재작성(fault-tolerant)', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), '{깨진 JSON');
    addOllamaProfile(tmp, 'qwen3:8b');
    expect(readBrains().brains.ollama.model).toBe('qwen3:8b');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/desktop/ollama.spec.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```typescript
// src/desktop/ollama.ts
import * as fs from 'fs';
import * as path from 'path';

// Ollama 도우미(스펙 §4): 로컬LLM은 별도 어댑터가 아니라 claude-cli 하네스의 백엔드 env 교체(Phase 3 구조).
// 따라서 프로필은 provider=claude-cli + env.ANTHROPIC_BASE_URL만 바꾼다. claude CLI는 여전히 필요.

const OLLAMA_URL = 'http://localhost:11434';

export async function detectOllama(
  fetchFn: typeof fetch = fetch,
  baseUrl: string = OLLAMA_URL,
): Promise<{ running: boolean; models: string[] }> {
  try {
    const res = await fetchFn(`${baseUrl}/api/tags`);
    if (!res.ok) return { running: false, models: [] };
    const json = (await res.json()) as { models?: { name: string }[] };
    return { running: true, models: (json.models ?? []).map((m) => m.name) };
  } catch {
    return { running: false, models: [] };
  }
}

// brains.json에 ollama 프로필을 병합 저장한다. 다른 프로필·설정은 보존, 깨진 파일은 기본 골격으로 재작성.
export function addOllamaProfile(configDir: string, model: string, setDefault = false): void {
  const file = path.join(configDir, 'brains.json');
  let cfg: { default: string; brains: Record<string, unknown> } = { default: 'claude', brains: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      cfg = { default: raw.default ?? 'claude', brains: raw.brains ?? {} };
    }
  } catch {
    // 없거나 깨짐 → 기본 골격
  }
  cfg.brains.ollama = {
    provider: 'claude-cli',
    cli: 'claude',
    model,
    env: { ANTHROPIC_BASE_URL: OLLAMA_URL },
  };
  if (setDefault) cfg.default = 'ollama';
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/desktop/ollama.spec.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: 커밋**

```powershell
git add src/desktop/ollama.ts src/desktop/ollama.spec.ts
git commit -m "feat(phase7): Ollama 감지 + brains.json 로컬 두뇌 프로필 작성"
```

---

### Task 8: Discord 토큰 저장 `src/desktop/messenger-writer.ts`

**Files:**
- Create: `src/desktop/messenger-writer.ts`
- Test: `src/desktop/messenger-writer.spec.ts`

**Interfaces:**
- Consumes: messenger.json 스키마 `{ provider?: string, token?: string }` (`src/edge/messenger/messenger.config.ts` — env ENGRAM_DISCORD_TOKEN이 파일보다 우선하는 건 로더 쪽 기존 동작)
- Produces: `saveDiscordToken(configDir: string, token: string): void` — `{...기존, provider:'discord', token}` 병합 저장

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
// src/desktop/messenger-writer.spec.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { saveDiscordToken } from './messenger-writer';

describe('saveDiscordToken', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-msgr-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('파일이 없으면 만들어서 저장', () => {
    saveDiscordToken(tmp, 'tok-123');
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'messenger.json'), 'utf8'));
    expect(cfg).toEqual({ provider: 'discord', token: 'tok-123' });
  });

  it('기존 키를 보존하며 병합', () => {
    fs.writeFileSync(path.join(tmp, 'messenger.json'), JSON.stringify({ 기타옵션: true }));
    saveDiscordToken(tmp, 'tok-456');
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'messenger.json'), 'utf8'));
    expect(cfg).toEqual({ 기타옵션: true, provider: 'discord', token: 'tok-456' });
  });

  it('깨진 JSON은 새로 쓴다', () => {
    fs.writeFileSync(path.join(tmp, 'messenger.json'), '{깨짐');
    saveDiscordToken(tmp, 'tok-789');
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'messenger.json'), 'utf8'));
    expect(cfg.token).toBe('tok-789');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/desktop/messenger-writer.spec.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```typescript
// src/desktop/messenger-writer.ts
import * as fs from 'fs';
import * as path from 'path';

// 설정창 메신저 섹션(스펙 §4): 토큰을 messenger.json에 저장한다(반영은 상주 재시작).
export function saveDiscordToken(configDir: string, token: string): void {
  const file = path.join(configDir, 'messenger.json');
  let cfg: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') cfg = raw;
  } catch {
    // 없거나 깨짐 → 새로 씀
  }
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...cfg, provider: 'discord', token }, null, 2));
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/desktop/messenger-writer.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```powershell
git add src/desktop/messenger-writer.ts src/desktop/messenger-writer.spec.ts
git commit -m "feat(phase7): Discord 토큰 저장(messenger.json 병합 쓰기)"
```

---

### Task 9: Electron 메인·preload·설정창 (배선 — 단위테스트 없음, 수동 스모크)

**Files:**
- Create: `src/desktop/main.ts` (Electron 메인: 트레이·창·자식 감독·IPC)
- Create: `src/desktop/preload.ts`
- Create: `src/desktop/settings.html` (설정창, 인라인 스크립트 — 별도 빌드 없음)
- Create: `scripts/gen-tray-icon.js` (트레이 아이콘 PNG 1회 생성 스크립트)
- Create: `src/desktop/assets/tray.png` (스크립트 산출물, 커밋)
- Modify: `package.json` (devDeps electron·electron-builder, `main` 필드, scripts `desktop:dev`)

**Interfaces:**
- Consumes: Task 4~8의 `readStatus`/`Backoff`/`STABLE_UPTIME_MS`/`WARN_AFTER`/`detectClaude`/`claudeInstallCommand`/`spawnRunner`/`detectOllama`/`addOllamaProfile`/`saveDiscordToken`
- Produces: IPC 채널(preload가 `window.engram`으로 노출) — `status()`, `detectClaude()`, `detectOllama()`, `addOllama(model, setDefault)`, `saveToken(token)`, `openPath(which)`, `restart()`, `logTail()`
- 주의: 이 태스크의 Electron API 부분은 단위테스트 대상이 아님(전역 제약). 로직은 전부 Task 4~8의 테스트된 모듈에 위임하고 main.ts는 배선만 얇게.

- [ ] **Step 1: 의존성 설치 + package.json 수정**

```powershell
npm install -D electron electron-builder
```

package.json에 추가 (기존 키 유지):

```json
{
  "main": "dist/src/desktop/main.js",
  "scripts": {
    "desktop:dev": "nest build && electron ."
  }
}
```

- [ ] **Step 2: 트레이 아이콘 생성 스크립트 작성·실행**

```javascript
// scripts/gen-tray-icon.js — 16x16 단색 PNG를 의존성 없이 생성(1회용, 산출물 커밋).
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

const W = 16, H = 16;
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  const row = y * (1 + W * 4);
  raw[row] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const i = row + 1 + x * 4;
    raw[i] = 0x4f; raw[i + 1] = 0x8e; raw[i + 2] = 0xf7; raw[i + 3] = 0xff; // 파랑
  }
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'src', 'desktop', 'assets', 'tray.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('생성:', out, png.length, 'bytes');
```

Run: `node scripts/gen-tray-icon.js`
Expected: `src/desktop/assets/tray.png` 생성 (수백 byte)

- [ ] **Step 3: preload 작성**

```typescript
// src/desktop/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

// 설정창(renderer)이 쓰는 최소 API. 파일 쓰기·감지는 전부 메인 프로세스가 수행(스펙 §4).
contextBridge.exposeInMainWorld('engram', {
  status: () => ipcRenderer.invoke('engram:status'),
  detectClaude: () => ipcRenderer.invoke('engram:detect-claude'),
  detectOllama: () => ipcRenderer.invoke('engram:detect-ollama'),
  addOllama: (model: string, setDefault: boolean) =>
    ipcRenderer.invoke('engram:add-ollama', model, setDefault),
  saveToken: (token: string) => ipcRenderer.invoke('engram:save-token', token),
  openPath: (which: string) => ipcRenderer.invoke('engram:open-path', which),
  restart: () => ipcRenderer.invoke('engram:restart'),
  logTail: () => ipcRenderer.invoke('engram:log-tail'),
});
```

- [ ] **Step 4: Electron 메인 작성**

```typescript
// src/desktop/main.ts
// Electron 껍데기(스펙 §3): 트레이 상주 + 설정창 + 자식(상주 main.js) 감독. 로직은 테스트된 모듈에 위임.
import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { readStatus } from './status';
import { Backoff, STABLE_UPTIME_MS, WARN_AFTER } from './backoff';
import { claudeInstallCommand, detectClaude, spawnRunner } from './claude-detect';
import { addOllamaProfile, detectOllama } from './ollama';
import { saveDiscordToken } from './messenger-writer';

const dataDir = app.getPath('userData'); // 예: %APPDATA%/Engram
const configDir = path.join(dataDir, 'config');
const childEnv = {
  ...process.env,
  ENGRAM_DATA_DIR: dataDir,
  ENGRAM_MODEL_CACHE_DIR: path.join(dataDir, 'models'),
};

let tray: Tray | null = null;
let settingsWin: BrowserWindow | null = null;
let child: UtilityProcess | null = null;
let quitting = false;
let childStartedAt = 0;
const backoff = new Backoff();

// ---- 자식(상주) 감독 ----
function startChild(): void {
  const entry = path.join(app.getAppPath(), 'dist', 'src', 'main.js');
  childStartedAt = Date.now();
  child = utilityProcess.fork(entry, [], { env: childEnv, stdio: 'ignore', serviceName: 'engram-core' });
  child.on('exit', () => {
    child = null;
    if (quitting) return;
    // 충분히 살아있었으면 정상 운행 중 크래시로 보고 백오프 리셋.
    if (Date.now() - childStartedAt >= STABLE_UPTIME_MS) backoff.reset();
    const delay = backoff.next();
    updateTray();
    setTimeout(() => {
      if (!quitting) startChild();
    }, delay);
  });
  updateTray();
}

function restartChild(): void {
  backoff.reset();
  if (child) {
    const c = child;
    child = null; // exit 핸들러의 자동재시작과 경합 방지: 먼저 끊고 직접 재시작
    c.removeAllListeners('exit');
    c.kill();
  }
  startChild();
}

// ---- 트레이 ----
function trayIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(path.join(app.getAppPath(), 'src', 'desktop', 'assets', 'tray.png'));
}

function updateTray(): void {
  if (!tray) return;
  const warn = backoff.consecutiveFails >= WARN_AFTER;
  tray.setToolTip(warn ? 'Engram — 상주 재시작 반복 실패(로그 확인)' : 'Engram');
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '설정 열기', click: () => openSettings() },
      { label: '상주 재시작', click: () => restartChild() },
      { type: 'separator' },
      { label: '종료', click: () => app.quit() },
    ]),
  );
  tray.on('double-click', () => openSettings());
  updateTray();
}

// ---- 설정창 ----
function openSettings(): void {
  if (settingsWin) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 760,
    height: 680,
    title: 'Engram 설정',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  void settingsWin.loadFile(path.join(app.getAppPath(), 'src', 'desktop', 'settings.html'));
  settingsWin.on('closed', () => (settingsWin = null));
}

// ---- IPC (로직은 테스트된 모듈 위임) ----
function registerIpc(): void {
  ipcMain.handle('engram:status', () => ({
    ...readStatus(dataDir, Date.now()),
    dataDir,
    childRunning: child !== null,
    consecutiveFails: backoff.consecutiveFails,
  }));
  ipcMain.handle('engram:detect-claude', async () => ({
    ...(await detectClaude(spawnRunner)),
    installCommand: claudeInstallCommand(process.platform),
  }));
  ipcMain.handle('engram:detect-ollama', () => detectOllama());
  ipcMain.handle('engram:add-ollama', (_e, model: string, setDefault: boolean) => {
    addOllamaProfile(configDir, model, setDefault);
  });
  ipcMain.handle('engram:save-token', (_e, token: string) => {
    saveDiscordToken(configDir, token);
  });
  ipcMain.handle('engram:open-path', (_e, which: string) => {
    const dirs: Record<string, string> = {
      data: dataDir,
      logs: path.join(dataDir, 'logs'),
      config: configDir,
    };
    const target = dirs[which] ?? dataDir;
    fs.mkdirSync(target, { recursive: true });
    return shell.openPath(target);
  });
  ipcMain.handle('engram:restart', () => restartChild());
  ipcMain.handle('engram:log-tail', () => {
    try {
      const text = fs.readFileSync(path.join(dataDir, 'logs', 'engram.log'), 'utf8');
      return text.split('\n').slice(-100).join('\n');
    } catch {
      return '(로그 없음)';
    }
  });
}

// ---- 부팅 ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit(); // 중복 실행: 기존 인스턴스에 양보(스펙 §7)
} else {
  app.on('second-instance', () => openSettings());
  app.on('before-quit', () => {
    quitting = true;
    child?.kill();
  });
  // 창을 다 닫아도 트레이 상주 유지(기본 quit 동작 차단).
  app.on('window-all-closed', () => {});
  void app.whenReady().then(() => {
    // 로그인 자동시작(스펙 §3). Linux는 API 미지원이라 제외, 개발 모드(비패키지)도 제외.
    if (app.isPackaged && process.platform !== 'linux') {
      app.setLoginItemSettings({ openAtLogin: true });
    }
    registerIpc();
    createTray();
    startChild();
  });
}
```

- [ ] **Step 5: 설정창 HTML 작성**

```html
<!-- src/desktop/settings.html -->
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>Engram 설정</title>
  <style>
    body { font-family: 'Malgun Gothic', sans-serif; margin: 16px; background: #1e1f22; color: #dbdee1; }
    h2 { font-size: 15px; border-bottom: 1px solid #3f4147; padding-bottom: 6px; margin-top: 24px; }
    .ok { color: #23a559; } .bad { color: #f23f43; }
    button { background: #4f8ef7; color: white; border: 0; border-radius: 4px; padding: 6px 12px; cursor: pointer; }
    input, select { background: #2b2d31; color: #dbdee1; border: 1px solid #3f4147; border-radius: 4px; padding: 6px; }
    pre { background: #111214; padding: 8px; border-radius: 4px; overflow: auto; max-height: 200px; font-size: 11px; }
    code { background: #2b2d31; padding: 2px 6px; border-radius: 3px; }
    .row { margin: 8px 0; }
  </style>
</head>
<body>
  <h2>상태</h2>
  <div class="row" id="status">확인 중…</div>
  <div class="row">
    <button id="btn-restart">상주 재시작</button>
    <button id="btn-refresh">새로고침</button>
  </div>
  <pre id="log"></pre>

  <h2>두뇌 연결</h2>
  <div class="row" id="claude">claude 확인 중…</div>
  <div class="row" id="ollama">Ollama 확인 중…</div>
  <div class="row" id="ollama-add" style="display:none">
    <select id="ollama-model"></select>
    <label><input type="checkbox" id="ollama-default" /> 기본 두뇌로 지정</label>
    <button id="btn-ollama">로컬 두뇌로 추가</button>
  </div>

  <h2>메신저 (Discord)</h2>
  <div class="row">
    봇 토큰: <input id="token" type="password" size="40" />
    <button id="btn-token">저장</button>
    <span id="token-saved"></span>
  </div>
  <div class="row">봇 생성: <code>https://discord.com/developers/applications</code> → Bot → 토큰 발급 · 저장 후 "상주 재시작"으로 반영</div>

  <h2>고급</h2>
  <div class="row">
    <button data-open="data">데이터 폴더</button>
    <button data-open="logs">로그 폴더</button>
    <button data-open="config">설정 폴더(JSON: brains·channels·coderepos·schedules)</button>
  </div>
  <div class="row">설정 파일을 직접 고친 뒤에는 "상주 재시작"으로 반영하세요.</div>

  <script>
    const $ = (id) => document.getElementById(id);

    async function refresh() {
      const s = await window.engram.status();
      const beat = s.lastBeat ? new Date(s.lastBeat).toLocaleString() : '없음';
      $('status').innerHTML =
        (s.alive ? '<span class="ok">● 상주 동작 중</span>' : '<span class="bad">● 상주 응답 없음</span>') +
        ' · 마지막 생존신호: ' + beat +
        ' · 임베딩 모델: ' + (s.modelCacheReady ? '준비됨' : '미준비(첫 질문 때 자동 다운로드)') +
        ' · 데이터: ' + s.dataDir +
        (s.consecutiveFails >= 3 ? ' · <span class="bad">재시작 반복 실패 — 로그 확인</span>' : '');
      $('log').textContent = await window.engram.logTail();
    }

    async function detect() {
      const c = await window.engram.detectClaude();
      $('claude').innerHTML = c.installed
        ? '<span class="ok">claude CLI 설치됨</span> (' + (c.version || '버전 미상') + ') — 로그인은 터미널에서 <code>claude</code> 실행'
        : '<span class="bad">claude CLI 미설치</span> — 터미널에서: <code>' + c.installCommand + '</code> ' +
          '<button onclick="navigator.clipboard.writeText(\'' + c.installCommand + '\')">복사</button>';
      const o = await window.engram.detectOllama();
      if (o.running) {
        $('ollama').innerHTML = '<span class="ok">Ollama 실행 중</span> (모델 ' + o.models.length + '개)';
        const sel = $('ollama-model');
        sel.innerHTML = o.models.map((m) => '<option>' + m + '</option>').join('');
        $('ollama-add').style.display = o.models.length ? 'block' : 'none';
      } else {
        $('ollama').innerHTML = 'Ollama 미실행 — 로컬 LLM을 쓰려면 <code>https://ollama.com</code>에서 설치 (claude CLI는 여전히 필요)';
      }
    }

    $('btn-restart').onclick = async () => { await window.engram.restart(); setTimeout(refresh, 1500); };
    $('btn-refresh').onclick = refresh;
    $('btn-ollama').onclick = async () => {
      await window.engram.addOllama($('ollama-model').value, $('ollama-default').checked);
      alert('brains.json에 추가했습니다. "상주 재시작"으로 반영하세요.');
    };
    $('btn-token').onclick = async () => {
      await window.engram.saveToken($('token').value.trim());
      $('token-saved').textContent = '저장됨 — 재시작으로 반영';
    };
    document.querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = () => window.engram.openPath(b.dataset.open);
    });

    refresh();
    detect();
  </script>
</body>
</html>
```

- [ ] **Step 6: 컴파일 + 전체 테스트 회귀**

Run: `npm run build; npx tsc --noEmit; npm test`
Expected: 빌드 클린(`dist/src/desktop/main.js`·`preload.js` 생성), 기존+신규 테스트 전부 PASS.
주의: settings.html은 tsc 산출물이 아니므로 dist에 없음 — main.ts가 `app.getAppPath()` 기준으로 소스 위치(`src/desktop/settings.html`)를 읽는 게 의도된 동작(개발=레포 루트, 패키지=asar 내 동봉).

- [ ] **Step 7: 수동 스모크 — `electron .`**

Run: `npm run desktop:dev`
확인 체크리스트:
1. 트레이에 파란 아이콘 표시
2. 트레이 더블클릭 → 설정창 열림, 상태(alive)·claude 감지 결과 표시
3. "상주 재시작" 클릭 → 로그에 재부팅 흔적
4. 창 닫아도 앱 유지(트레이), 트레이 "종료"로 완전 종료
5. 데이터가 `%APPDATA%/Engram` 아래 생성됐는지 확인

- [ ] **Step 8: 커밋**

```powershell
git add src/desktop/main.ts src/desktop/preload.ts src/desktop/settings.html src/desktop/assets/tray.png scripts/gen-tray-icon.js package.json package-lock.json
git commit -m "feat(phase7): Electron 셸 — 트레이 상주·설정창·자식 감독·IPC"
```

---

### Task 10: electron-builder 설정 + 로컬 Windows 인스톨러

**Files:**
- Modify: `package.json` (`build` 키 + scripts `desktop:build`)
- Modify: `.gitignore` (`release/` 추가)

**Interfaces:**
- Consumes: Task 9의 `main: dist/src/desktop/main.js`
- Produces: `release/Engram Setup <version>.exe` (NSIS). CI(Task 11)가 같은 설정으로 mac/linux 빌드.

- [ ] **Step 1: package.json에 build 설정 추가**

```json
{
  "scripts": {
    "desktop:build": "nest build && electron-builder"
  },
  "build": {
    "appId": "dev.engram.desktop",
    "productName": "Engram",
    "directories": { "output": "release" },
    "files": [
      "dist/**",
      "prompts/**",
      "personas/**",
      "src/desktop/assets/**",
      "src/desktop/settings.html"
    ],
    "win": { "target": "nsis" },
    "mac": { "target": "dmg" },
    "linux": { "target": "AppImage" }
  }
}
```

`.gitignore`에 `release/` 한 줄 추가.

참고: node_modules(프로덕션 deps)는 electron-builder가 자동 동봉·프루닝. 네이티브 `.node`
바이너리(@lancedb, onnxruntime)는 smartUnpack이 asar 밖으로 자동으로 뺀다. 커스텀 아이콘 없음
→ 기본 Electron 아이콘 + 빌드 경고 1줄(수용, 후속).

- [ ] **Step 2: 로컬 Windows 빌드**

Run: `npm run desktop:build`
Expected: `release/Engram Setup 0.0.1.exe` 생성 (수 분 소요, 150~300MB).
실패 시 확인 포인트: asar 안 utilityProcess fork 오류가 나면 `"asar": false`를 build에 추가하고 재시도(트레이드오프: 파일 수 증가, 동작 동일 — 주석으로 남길 것).

- [ ] **Step 3: 설치 스모크 (스펙 §8 체크리스트 1~5)**

인스톨러 실행 후 확인:
1. 설치 완료 → 앱 자동 실행, 트레이 아이콘 표시
2. 상주 기동: 설정창 상태가 1~2분 내 "동작 중"(heartbeat 갱신)
3. 설정창: claude 감지·Ollama 감지 표시 정상
4. (선택, 토큰 있으면) Discord 토큰 입력 → 재시작 → 실봇 멘션 응답
5. 작업관리자에서 자식(engram-core) 강제 종료 → 5초 내 자동 재시작
6. 제거(설정→앱→Engram 제거) → 앱 삭제, `%APPDATA%/Engram` 데이터는 보존 확인

- [ ] **Step 4: 커밋**

```powershell
git add package.json .gitignore
git commit -m "feat(phase7): electron-builder 설정 — Windows NSIS 로컬 빌드"
```

---

### Task 11: GitHub Actions 3-OS 릴리스 워크플로우

**Files:**
- Create: `.github/workflows/desktop-release.yml`

**Interfaces:**
- Consumes: Task 10의 electron-builder 설정(플랫폼별 타깃 자동 선택)
- Produces: `v*` 태그 푸시 → GitHub Release에 인스톨러 3종(exe/dmg/AppImage) 업로드

- [ ] **Step 1: 워크플로우 작성**

```yaml
# .github/workflows/desktop-release.yml
# v* 태그 푸시 시 3-OS 인스톨러를 빌드해 GitHub Release에 올린다(스펙 §6).
# macOS 인스톨러는 macOS에서만 빌드 가능해서 CI 매트릭스가 필수.
name: desktop-release

on:
  push:
    tags: ['v*']

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, macos-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      # 테스트는 Windows에서만(로컬 검증 환경과 동일 — mac/linux 테스트 호환은 비범위).
      - run: npm test
        if: runner.os == 'Windows'
      - run: npm run build
      - run: npx electron-builder --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # 무서명 배포(스펙 §6): mac 서명 자동탐색 끔.
          CSC_IDENTITY_AUTO_DISCOVERY: 'false'
```

- [ ] **Step 2: YAML 문법 검증**

Run: `npx --yes js-yaml .github/workflows/desktop-release.yml`
Expected: 파싱된 YAML이 출력되고 오류 없음(js-yaml CLI는 파싱 실패 시 비0 종료). 실제 3-OS 빌드 검증은 태그 푸시 때(비범위 아님 — Task 12 후 사용자가 `git tag v0.1.0 && git push origin v0.1.0`으로 트리거).

- [ ] **Step 3: 커밋**

```powershell
git add .github/workflows/desktop-release.yml
git commit -m "ci(phase7): v* 태그 → 3-OS 인스톨러 릴리스 워크플로우"
```

---

### Task 12: README 안내 + 최종 검증

**Files:**
- Modify: `README.md` (설치형 앱 섹션 추가)

**Interfaces:**
- Consumes: 전체 태스크 산출물

- [ ] **Step 1: README에 설치형 앱 섹션 추가** (기존 운영 안내 근처, 아래 내용 포함)

```markdown
## 설치형 데스크톱 앱 (Phase 7)

- 설치: GitHub Release에서 OS별 인스톨러(exe/dmg/AppImage) 다운로드 후 실행.
  - 서명이 없어 Windows SmartScreen은 "추가 정보 → 실행", macOS는 앱 우클릭 → 열기로 통과.
- 실행하면 트레이 아이콘으로 상주하고, 로그인 시 자동 시작한다(Windows/macOS).
- 설정창(트레이 더블클릭): 상주 상태·claude 감지·Ollama 로컬 두뇌 추가·Discord 토큰 저장·설정 JSON 폴더 열기.
- 데이터 위치: OS 사용자 데이터 폴더(Windows `%APPDATA%/Engram`). 기존 레포 `runtime/` 데이터를
  옮기려면 폴더 내용을 그대로 복사하면 된다(자동 마이그레이션 없음).
- 임베딩 모델은 첫 질문 때 자동 다운로드된다(수백 MB, 최초 1회).
- 개발 실행: `npm run desktop:dev` · Windows 인스톨러 로컬 빌드: `npm run desktop:build`
- 릴리스: `v*` 태그 푸시 → GitHub Actions가 3-OS 인스톨러를 Release에 업로드.
- 서버 모드(GUI 없는 상주)는 기존 `engram service`(PAL) 그대로.
```

- [ ] **Step 2: 최종 전체 검증**

Run: `npm test; npx tsc --noEmit; npm run build`
Expected: 전체 테스트 PASS(기존 437 + 신규 ~24), 타입·빌드 클린.

- [ ] **Step 3: 커밋**

```powershell
git add README.md
git commit -m "docs(phase7): 설치형 데스크톱 앱 사용 안내"
```

---

## 검증 한계 (스펙 §8과 동일 — 실행자에게 고지)

- Mac/Linux 인스톨러는 이 Windows 머신에서 실행 검증 불가 — CI 빌드 성공까지가 게이트.
- CI 워크플로우의 실제 3-OS 실행은 태그 푸시 때 확인(로컬에서 YAML 문법만).
- Discord 실봇 스모크(Task 10 Step 3의 4번)는 토큰이 있을 때만 — 없으면 건너뛰고 보고에 명시.
