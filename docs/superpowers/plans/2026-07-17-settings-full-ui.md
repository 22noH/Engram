# 설정 전면 UI화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설정창을 애플 시스템 설정 문법(색 아이콘 타일 사이드바+검색+그룹 인셋 리스트)으로 개편하고, JSON 편집 전용이던 5개 설정(두뇌 세부·권한 상세·coderepos·예약·위키 원격)을 전부 UI로 노출한다.

**Architecture:** 검증된 3층 반복 — desktop 순수 함수(TDD) → IPC 얇은 위임 → settings.html 폼. 서버 코드 무변경. 스펙: `docs/superpowers/specs/2026-07-17-settings-full-ui-design.md` (구현자는 자기 태스크 관련 §만 참조).

**Tech Stack:** Electron(main/preload/settings.html 인라인 JS), TypeScript, Jest. 외부 라이브러리·폰트·아이콘 폰트 추가 금지(아이콘=인라인 SVG).

## Global Constraints

- 이 머신은 Bash 도구가 불안정 — 명령은 **PowerShell**로. jest 백그라운드 실행 금지(행 걸림), 포그라운드만.
- 테스트: `npm test -- --testPathPattern="<파일명>"`, 전체 `npm test`. 빌드: `npm run build`.
- UI 문구 **영어 기본 + ko 로케일**(settings.html `t` 객체 두 벌 모두).
- 렌더러 동적 문자열은 **textContent/createTextNode만** — innerHTML 금지(파일 유래 문자열이 DOM에 들어감).
- **API 키 원문은 렌더러로 절대 미전송** — hasApiKey boolean만. 저장 시 빈 입력=기존 값 보존.
- 커밋 메시지에 Co-Authored-By 금지.
- 서버 코드(src/agent-layer·brain·edge·knowledge-core) 무변경. 기존 desktop 함수(mergeBrainProfile·listBrains·setDefaultBrain·removeBrainProfile·slugFromModel·getCommandMode·setCommandMode) 무변경.
- 모든 config 쓰기 함수는 부분 갱신(다른 필드 보존)+fault-tolerant(없는/깨진 파일 no-op 또는 골격 생성 — 각 태스크 명세를 따름).

---

### Task 1: brains-file.ts — listBrainDetails + updateBrainProfile

**Files:**
- Modify: `src/desktop/brains-file.ts`
- Test: `src/desktop/brains-file.spec.ts`

**Interfaces:**
- Consumes: brains.json 스키마 `{ default, brains: Record<key, profile> }`.
- Produces (Task 4·6이 이 시그니처 사용):

```typescript
export interface BrainDetail {
  key: string; provider: string; model: string; baseUrl: string;
  maxTokens: number | null; inputUsdPerMTok: number | null; outputUsdPerMTok: number | null;
  searchProvider: string; hasApiKey: boolean; hasSearchApiKey: boolean; isDefault: boolean;
}
export function listBrainDetails(configDir: string): BrainDetail[];
export interface BrainPatch {
  model?: string; baseUrl?: string; searchProvider?: string;   // '' = 필드 제거, undefined = 유지
  apiKey?: string; searchApiKey?: string;                       // ''/undefined = 기존 보존, 값 = 교체
  maxTokens?: number | null; inputUsdPerMTok?: number | null; outputUsdPerMTok?: number | null; // null = 필드 제거, 유한 양수만 채택
}
export function updateBrainProfile(configDir: string, key: string, patch: BrainPatch, newKey?: string): boolean;
```

- [ ] **Step 1: 실패하는 테스트 작성** — `brains-file.spec.ts` 끝에 추가 (import 줄에 `listBrainDetails, updateBrainProfile` 병기):

```typescript
describe('listBrainDetails', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-bd-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('전 필드 + hasApiKey(원문 미포함) + isDefault', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), JSON.stringify({
      default: 'q',
      brains: { q: { provider: 'openai-api', model: 'qwen3:8b', baseUrl: 'http://x/v1', apiKey: 'sk-secret', maxTokens: 8000, inputUsdPerMTok: 1, searchProvider: 'brave', searchApiKey: 'bk' } },
    }));
    const [d] = listBrainDetails(tmp);
    expect(d).toEqual({
      key: 'q', provider: 'openai-api', model: 'qwen3:8b', baseUrl: 'http://x/v1',
      maxTokens: 8000, inputUsdPerMTok: 1, outputUsdPerMTok: null,
      searchProvider: 'brave', hasApiKey: true, hasSearchApiKey: true, isDefault: true,
    });
    expect(JSON.stringify(listBrainDetails(tmp))).not.toContain('sk-secret');
  });
  it('없는/깨진 파일 → []', () => {
    expect(listBrainDetails(tmp)).toEqual([]);
    fs.writeFileSync(path.join(tmp, 'brains.json'), '{깨진');
    expect(listBrainDetails(tmp)).toEqual([]);
  });
});

describe('updateBrainProfile', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-up-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const file = () => path.join(tmp, 'brains.json');
  const read = () => JSON.parse(fs.readFileSync(file(), 'utf8'));
  const seed = () => fs.writeFileSync(file(), JSON.stringify({
    default: 'q', brains: { q: { provider: 'openai-api', model: 'qwen3:8b', apiKey: 'OLD' }, c: { provider: 'claude-cli' } },
  }));

  it('부분 갱신: 정의된 필드만, apiKey 빈문자열은 기존 보존', () => {
    seed();
    expect(updateBrainProfile(tmp, 'q', { model: 'qwen3:14b', apiKey: '', maxTokens: 9000 })).toBe(true);
    const b = read().brains.q;
    expect(b).toEqual({ provider: 'openai-api', model: 'qwen3:14b', apiKey: 'OLD', maxTokens: 9000 });
  });
  it('apiKey 새 값은 교체, 숫자 null은 필드 제거, 문자열 빈값은 필드 제거', () => {
    seed();
    fs.writeFileSync(file(), JSON.stringify({ default: 'q', brains: { q: { model: 'm', baseUrl: 'http://x', apiKey: 'OLD', maxTokens: 1 } } }));
    updateBrainProfile(tmp, 'q', { apiKey: 'NEW', maxTokens: null, baseUrl: '' });
    expect(read().brains.q).toEqual({ model: 'm', apiKey: 'NEW' });
  });
  it('숫자 비정상(0·음수·NaN)은 무시(기존 유지)', () => {
    seed();
    updateBrainProfile(tmp, 'q', { maxTokens: -5 });
    expect(read().brains.q.maxTokens).toBeUndefined();
    fs.writeFileSync(file(), JSON.stringify({ default: 'q', brains: { q: { maxTokens: 7 } } }));
    updateBrainProfile(tmp, 'q', { maxTokens: Number.NaN });
    expect(read().brains.q.maxTokens).toBe(7);
  });
  it('이름변경: 이동+default 포인터 이동, 새 이름 충돌은 false(무변경)', () => {
    seed();
    expect(updateBrainProfile(tmp, 'q', {}, 'qwen')).toBe(true);
    const cfg = read();
    expect(cfg.brains.qwen.model).toBe('qwen3:8b');
    expect(cfg.brains.q).toBeUndefined();
    expect(cfg.default).toBe('qwen');
    expect(updateBrainProfile(tmp, 'qwen', {}, 'c')).toBe(false);
    expect(read().brains.qwen.model).toBe('qwen3:8b');
  });
  it('없는 key·없는/깨진 파일 → false·무변경', () => {
    expect(updateBrainProfile(tmp, 'ghost', {})).toBe(false);
    fs.writeFileSync(file(), '{깨진');
    expect(updateBrainProfile(tmp, 'q', {})).toBe(false);
    expect(fs.readFileSync(file(), 'utf8')).toBe('{깨진');
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm test -- --testPathPattern="brains-file"` / Expected: FAIL(export 없음).

- [ ] **Step 3: 구현** — `brains-file.ts` 끝에 추가:

```typescript
export interface BrainDetail {
  key: string; provider: string; model: string; baseUrl: string;
  maxTokens: number | null; inputUsdPerMTok: number | null; outputUsdPerMTok: number | null;
  searchProvider: string; hasApiKey: boolean; hasSearchApiKey: boolean; isDefault: boolean;
}

// 편집 폼용 상세 목록. ★API 키 원문은 렌더러로 안 보낸다 — has* boolean만.
export function listBrainDetails(configDir: string): BrainDetail[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'brains.json'), 'utf8'));
    const brains = raw && typeof raw.brains === 'object' && raw.brains && !Array.isArray(raw.brains) ? raw.brains : {};
    const def = typeof raw?.default === 'string' ? raw.default : 'claude';
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
    return Object.keys(brains).map((key) => {
      const b = brains[key] ?? {};
      return {
        key,
        provider: String(b.provider ?? ''),
        model: String(b.model ?? ''),
        baseUrl: String(b.baseUrl ?? ''),
        maxTokens: num(b.maxTokens),
        inputUsdPerMTok: num(b.inputUsdPerMTok),
        outputUsdPerMTok: num(b.outputUsdPerMTok),
        searchProvider: String(b.searchProvider ?? ''),
        hasApiKey: typeof b.apiKey === 'string' && b.apiKey.length > 0,
        hasSearchApiKey: typeof b.searchApiKey === 'string' && b.searchApiKey.length > 0,
        isDefault: key === def,
      };
    });
  } catch {
    return [];
  }
}

export interface BrainPatch {
  model?: string; baseUrl?: string; searchProvider?: string;
  apiKey?: string; searchApiKey?: string;
  maxTokens?: number | null; inputUsdPerMTok?: number | null; outputUsdPerMTok?: number | null;
}

// 프로필 부분 갱신(+선택 이름변경). 규칙: 문자열 ''=필드 제거(키 계열은 예외=보존),
// 숫자 null=필드 제거·유한 양수만 채택. 이름변경은 default 포인터까지 원자 이동,
// newKey 충돌·없는 key·깨진 파일은 false(무변경).
export function updateBrainProfile(configDir: string, key: string, patch: BrainPatch, newKey?: string): boolean {
  const file = path.join(configDir, 'brains.json');
  let raw: { default?: string; brains?: Record<string, Record<string, unknown>> };
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  if (!raw || typeof raw !== 'object' || !raw.brains || typeof raw.brains !== 'object') return false;
  const profile = raw.brains[key];
  if (!profile || typeof profile !== 'object') return false;

  const setStr = (field: 'model' | 'baseUrl' | 'searchProvider'): void => {
    const v = patch[field];
    if (v === undefined) return;
    if (v === '') delete profile[field];
    else profile[field] = v;
  };
  const setSecret = (field: 'apiKey' | 'searchApiKey'): void => {
    const v = patch[field];
    if (v === undefined || v === '') return; // 빈 입력 = 기존 보존
    profile[field] = v;
  };
  const setNum = (field: 'maxTokens' | 'inputUsdPerMTok' | 'outputUsdPerMTok'): void => {
    const v = patch[field];
    if (v === undefined) return;
    if (v === null) { delete profile[field]; return; }
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) profile[field] = v;
  };
  setStr('model'); setStr('baseUrl'); setStr('searchProvider');
  setSecret('apiKey'); setSecret('searchApiKey');
  setNum('maxTokens'); setNum('inputUsdPerMTok'); setNum('outputUsdPerMTok');

  if (newKey !== undefined && newKey !== key) {
    if (!newKey.trim() || newKey in raw.brains) return false;
    Object.defineProperty(raw.brains, newKey, { value: profile, enumerable: true, writable: true, configurable: true });
    delete raw.brains[key];
    if (raw.default === key) raw.default = newKey;
  }
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  return true;
}
```

- [ ] **Step 4: 통과 확인** — Run: `npm test -- --testPathPattern="brains-file"` / Expected: PASS(기존 포함 전부).
- [ ] **Step 5: 커밋** — `git add src/desktop/brains-file.ts src/desktop/brains-file.spec.ts; git commit -m "feat(settings-ui): listBrainDetails(키 미전송)+updateBrainProfile(부분갱신·이름변경 원자)"`

---

### Task 2: permissions-file.ts — getPermissionDetails + setPermissionList

**Files:**
- Modify: `src/desktop/permissions-file.ts`
- Test: `src/desktop/permissions-file.spec.ts`

**Interfaces:**
- Produces (Task 4·7 사용):

```typescript
export interface PermissionDetails { writePaths: string[]; denyPaths: string[]; commands: string[] | null }
export function getPermissionDetails(configDir: string): PermissionDetails; // commands null = 미지정(내장 기본)
export function setPermissionList(configDir: string, field: 'writePaths' | 'denyPaths' | 'commands', values: string[] | null): void; // commands에만 null 허용 = 필드 삭제(기본 복귀)
```

- [ ] **Step 1: 실패하는 테스트 작성** — `permissions-file.spec.ts` 끝에 추가 (import에 두 함수 병기; 파일 상단 fs/os/path import는 기존 스타일 확인):

```typescript
describe('getPermissionDetails / setPermissionList', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-perm-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const file = () => path.join(tmp, 'permissions.json');
  const read = () => JSON.parse(fs.readFileSync(file(), 'utf8'));

  it('읽기: 미지정 commands는 null, 배열은 그대로', () => {
    expect(getPermissionDetails(tmp)).toEqual({ writePaths: [], denyPaths: [], commands: null });
    fs.writeFileSync(file(), JSON.stringify({ default: 'deny', allow: { tools: {}, writePaths: ['C:\\a'], denyPaths: [], commands: [] } }));
    expect(getPermissionDetails(tmp)).toEqual({ writePaths: ['C:\\a'], denyPaths: [], commands: [] });
  });
  it('쓰기: 부분 갱신(다른 필드·commandMode 보존), 골격 없으면 생성', () => {
    fs.writeFileSync(file(), JSON.stringify({ default: 'deny', allow: { tools: { dev: ['Bash'] }, writePaths: [], denyPaths: [], commandMode: 'allowlist' } }));
    setPermissionList(tmp, 'writePaths', ['C:\\src']);
    const cfg = read();
    expect(cfg.allow.writePaths).toEqual(['C:\\src']);
    expect(cfg.allow.tools).toEqual({ dev: ['Bash'] });
    expect(cfg.allow.commandMode).toBe('allowlist');
  });
  it('commands: 배열 설정·null이면 필드 삭제(내장 기본 복귀)', () => {
    setPermissionList(tmp, 'commands', ['npm', 'git']);
    expect(read().allow.commands).toEqual(['npm', 'git']);
    setPermissionList(tmp, 'commands', null);
    expect('commands' in read().allow).toBe(false);
  });
  it('깨진 파일이면 골격 재작성(setCommandMode와 동일 결)', () => {
    fs.writeFileSync(file(), '{깨진');
    setPermissionList(tmp, 'denyPaths', ['C:\\Windows']);
    expect(read().allow.denyPaths).toEqual(['C:\\Windows']);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm test -- --testPathPattern="permissions-file"` / Expected: FAIL.
- [ ] **Step 3: 구현** — `permissions-file.ts` 끝에 추가 (기존 setCommandMode의 골격 로직과 동일 결):

```typescript
export interface PermissionDetails { writePaths: string[]; denyPaths: string[]; commands: string[] | null }

export function getPermissionDetails(configDir: string): PermissionDetails {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'permissions.json'), 'utf8'));
    const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);
    return {
      writePaths: strArr(raw?.allow?.writePaths),
      denyPaths: strArr(raw?.allow?.denyPaths),
      commands: Array.isArray(raw?.allow?.commands) ? raw.allow.commands.filter((s: unknown) => typeof s === 'string') : null,
    };
  } catch {
    return { writePaths: [], denyPaths: [], commands: null };
  }
}

// 목록 필드 부분 갱신. commands에만 null 허용 = 필드 삭제(내장 DEFAULT_COMMANDS 복귀).
export function setPermissionList(configDir: string, field: 'writePaths' | 'denyPaths' | 'commands', values: string[] | null): void {
  const file = path.join(configDir, 'permissions.json');
  let cfg: { default: string; allow: Record<string, unknown> } = { default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') cfg = raw;
  } catch { /* 없거나 깨짐 → 골격 */ }
  if (!cfg.allow || typeof cfg.allow !== 'object') cfg.allow = { tools: {}, writePaths: [], denyPaths: [] };
  if (values === null) delete cfg.allow[field];
  else cfg.allow[field] = values;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}
```

- [ ] **Step 4: 통과 확인** — Run: `npm test -- --testPathPattern="permissions-file"` / Expected: PASS.
- [ ] **Step 5: 커밋** — `git add src/desktop/permissions-file.ts src/desktop/permissions-file.spec.ts; git commit -m "feat(settings-ui): 권한 상세 읽기/쓰기 — writePaths·denyPaths·commands(3상태)"`

---

### Task 3: 신규 config 모듈 3종 — coderepos-file · schedules-file · wiki-remote-file

**Files:**
- Create: `src/desktop/coderepos-file.ts` + `src/desktop/coderepos-file.spec.ts`
- Create: `src/desktop/schedules-file.ts` + `src/desktop/schedules-file.spec.ts`
- Create: `src/desktop/wiki-remote-file.ts` + `src/desktop/wiki-remote-file.spec.ts`

**Interfaces:**
- Consumes: `loadCodeRepos`(`src/agent-layer/coderepos.ts`)·`ScheduleEntry` 타입(`src/agent-layer/schedule-store.ts`) — import만, 무변경.
- Produces (Task 4·7·8 사용):

```typescript
// coderepos-file.ts
export function setAlias(configDir: string, alias: string, targetPath: string): boolean; // trim, 빈 alias/경로 false
export function removeAlias(configDir: string, alias: string): void;
export function setSearchRoots(configDir: string, roots: string[]): void;
// schedules-file.ts
export function listSchedules(configDir: string): ScheduleEntry[];
export function removeScheduleFromFile(configDir: string, id: string): boolean;
// wiki-remote-file.ts
export interface WikiRemoteForm { remote: string; branch: string; syncIntervalSec: number }
export function readWikiRemoteFile(configDir: string): WikiRemoteForm; // 폼 초기값용 raw 읽기(기본 branch 'main'·interval 60)
export function saveWikiRemote(configDir: string, cfg: WikiRemoteForm): void; // interval 비정상 → 60
```

- [ ] **Step 1: 실패하는 테스트 3파일 작성** (각 파일 상단 `import * as fs/os/path` — 기존 spec 스타일):

`coderepos-file.spec.ts`:

```typescript
import { setAlias, removeAlias, setSearchRoots } from './coderepos-file';
import { loadCodeRepos } from '../agent-layer/coderepos';

describe('coderepos-file', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cr-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('setAlias: 추가·덮어쓰기, trim, 빈 값 false', () => {
    expect(setAlias(tmp, ' engram ', 'C:\\Src\\Engram')).toBe(true);
    expect(loadCodeRepos(tmp).aliases.engram).toBe('C:\\Src\\Engram');
    expect(setAlias(tmp, '', 'C:\\x')).toBe(false);
    expect(setAlias(tmp, 'a', '  ')).toBe(false);
  });
  it('removeAlias 멱등 + searchRoots 보존', () => {
    setAlias(tmp, 'a', 'C:\\a');
    setSearchRoots(tmp, ['C:\\Src']);
    removeAlias(tmp, 'a');
    removeAlias(tmp, 'a');
    expect(loadCodeRepos(tmp)).toEqual({ aliases: {}, searchRoots: ['C:\\Src'] });
  });
  it('깨진 파일이면 골격에서 시작', () => {
    fs.writeFileSync(path.join(tmp, 'coderepos.json'), '{깨진');
    setSearchRoots(tmp, ['C:\\Src']);
    expect(loadCodeRepos(tmp).searchRoots).toEqual(['C:\\Src']);
  });
});
```

`schedules-file.spec.ts`:

```typescript
import { listSchedules, removeScheduleFromFile } from './schedules-file';

describe('schedules-file', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const seed = () => fs.writeFileSync(path.join(tmp, 'schedules.json'), JSON.stringify([
    { id: 's1', channelId: 'ch1', cron: '0 9 * * 1-5', task: '브리핑', createdAt: 't' },
    { id: 's2', channelId: 'ch2', cron: '0 18 * * 5', task: '회고', once: true, createdAt: 't' },
  ]));

  it('listSchedules: 배열 반환, 없는/깨진 파일 []', () => {
    expect(listSchedules(tmp)).toEqual([]);
    seed();
    expect(listSchedules(tmp).map((e) => e.id)).toEqual(['s1', 's2']);
    fs.writeFileSync(path.join(tmp, 'schedules.json'), '{깨진');
    expect(listSchedules(tmp)).toEqual([]);
  });
  it('removeScheduleFromFile: 삭제 true·없으면 false(무변경)', () => {
    seed();
    expect(removeScheduleFromFile(tmp, 's1')).toBe(true);
    expect(listSchedules(tmp).map((e) => e.id)).toEqual(['s2']);
    expect(removeScheduleFromFile(tmp, 'ghost')).toBe(false);
  });
});
```

`wiki-remote-file.spec.ts`:

```typescript
import { readWikiRemoteFile, saveWikiRemote } from './wiki-remote-file';

describe('wiki-remote-file', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-wr-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('읽기: 없는/깨진 파일 → 기본값(remote 빈·branch main·60)', () => {
    expect(readWikiRemoteFile(tmp)).toEqual({ remote: '', branch: 'main', syncIntervalSec: 60 });
  });
  it('저장→읽기 왕복, interval 비정상은 60', () => {
    saveWikiRemote(tmp, { remote: 'git@nas:wiki.git', branch: 'wiki', syncIntervalSec: 120 });
    expect(readWikiRemoteFile(tmp)).toEqual({ remote: 'git@nas:wiki.git', branch: 'wiki', syncIntervalSec: 120 });
    saveWikiRemote(tmp, { remote: '', branch: '', syncIntervalSec: -1 });
    expect(readWikiRemoteFile(tmp)).toEqual({ remote: '', branch: 'main', syncIntervalSec: 60 });
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npm test -- --testPathPattern="coderepos-file|schedules-file|wiki-remote-file"` / Expected: FAIL(모듈 없음).
- [ ] **Step 3: 구현 3파일**:

`coderepos-file.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { loadCodeRepos, CodeReposConfig } from '../agent-layer/coderepos';

// coderepos.json 쓰기(설정창 전용). 읽기는 agent-layer loadCodeRepos 재사용(fault-tolerant).
function save(configDir: string, cfg: CodeReposConfig): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'coderepos.json'), JSON.stringify(cfg, null, 2));
}

export function setAlias(configDir: string, alias: string, targetPath: string): boolean {
  const a = alias.trim();
  const p = targetPath.trim();
  if (!a || !p) return false;
  const cfg = loadCodeRepos(configDir);
  cfg.aliases[a] = p;
  save(configDir, cfg);
  return true;
}

export function removeAlias(configDir: string, alias: string): void {
  const cfg = loadCodeRepos(configDir);
  if (!(alias in cfg.aliases)) return;
  delete cfg.aliases[alias];
  save(configDir, cfg);
}

export function setSearchRoots(configDir: string, roots: string[]): void {
  const cfg = loadCodeRepos(configDir);
  cfg.searchRoots = roots.map((r) => r.trim()).filter(Boolean);
  save(configDir, cfg);
}
```

`schedules-file.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { ScheduleEntry } from '../agent-layer/schedule-store';

// 설정창용 schedules.json 직접 읽기/삭제. ★알려진 경합(스펙 §3.6): 서버가 메모리 사본을
// 들고 쓰는 파일 — 삭제는 재시작해야 크론에 반영되고, 재시작 전 서버 저장이 삭제분을
// 부활시킬 수 있다. ponytail: 낮은 확률 수용, 업그레이드 경로 = ws admin 프레임.
export function listSchedules(configDir: string): ScheduleEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'schedules.json'), 'utf8'));
    return Array.isArray(parsed) ? (parsed as ScheduleEntry[]) : [];
  } catch {
    return [];
  }
}

export function removeScheduleFromFile(configDir: string, id: string): boolean {
  const entries = listSchedules(configDir);
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  fs.writeFileSync(path.join(configDir, 'schedules.json'), JSON.stringify(next, null, 2));
  return true;
}
```

`wiki-remote-file.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

// 설정창 폼용 wiki-remote.json 읽기/쓰기. knowledge-core loadWikiRemote는 remote 없으면
// null이라 폼 초기값용으로 부적합 — raw를 직접 읽어 기본값을 채운다.
export interface WikiRemoteForm { remote: string; branch: string; syncIntervalSec: number }

export function readWikiRemoteFile(configDir: string): WikiRemoteForm {
  let raw: Partial<WikiRemoteForm> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'wiki-remote.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
  } catch { /* 없거나 깨짐 → 기본값 */ }
  const n = Number(raw.syncIntervalSec);
  return {
    remote: typeof raw.remote === 'string' ? raw.remote.trim() : '',
    branch: (typeof raw.branch === 'string' && raw.branch.trim()) || 'main',
    syncIntervalSec: Number.isFinite(n) && n > 0 ? n : 60,
  };
}

export function saveWikiRemote(configDir: string, cfg: WikiRemoteForm): void {
  const n = Number(cfg.syncIntervalSec);
  const out: WikiRemoteForm = {
    remote: cfg.remote.trim(),
    branch: cfg.branch.trim() || 'main',
    syncIntervalSec: Number.isFinite(n) && n > 0 ? n : 60,
  };
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'wiki-remote.json'), JSON.stringify(out, null, 2));
}
```

- [ ] **Step 4: 통과 확인** — Run: `npm test -- --testPathPattern="coderepos-file|schedules-file|wiki-remote-file"` / Expected: PASS. 이어서 `npm run build` clean(크로스 레이어 import 확인).
- [ ] **Step 5: 커밋** — `git add src/desktop/coderepos-file.ts src/desktop/coderepos-file.spec.ts src/desktop/schedules-file.ts src/desktop/schedules-file.spec.ts src/desktop/wiki-remote-file.ts src/desktop/wiki-remote-file.spec.ts; git commit -m "feat(settings-ui): config 파일 모듈 3종 — coderepos·schedules(경합 문서화)·wiki-remote"`

---

### Task 4: IPC 12채널 + preload

**Files:**
- Modify: `src/desktop/main.ts` (registerIpc 안, 기존 `engram:slug-model` 줄 아래)
- Modify: `src/desktop/preload.ts`

**Interfaces:**
- Consumes: Task 1~3의 전 함수(시그니처는 각 태스크 Produces 그대로).
- Produces: `window.engram.*` — Task 6~8의 settings.html이 사용:
  `listBrainDetails()` `updateBrainProfile(key, patch, newKey?)→boolean` `getPermissionDetails()` `setPermissionList(field, values)` `getCodeRepos()` `setCodeAlias(alias, path)→boolean` `removeCodeAlias(alias)` `setSearchRoots(roots)` `listSchedules()` `removeSchedule(id)→boolean` `getWikiRemote()` `setWikiRemote(cfg)`

- [ ] **Step 1: main.ts 핸들러 추가** (import 병합: brains-file에서 `listBrainDetails, updateBrainProfile`·permissions-file에서 `getPermissionDetails, setPermissionList`·신규 3모듈·agent-layer `loadCodeRepos`):

```typescript
  ipcMain.handle('engram:list-brain-details', () => listBrainDetails(configDir));
  ipcMain.handle('engram:update-brain-profile', (_e, key: string, patch: BrainPatch, newKey?: string) =>
    updateBrainProfile(configDir, key, patch, newKey));
  ipcMain.handle('engram:get-permission-details', () => getPermissionDetails(configDir));
  ipcMain.handle('engram:set-permission-list', (_e, field: 'writePaths' | 'denyPaths' | 'commands', values: string[] | null) => {
    setPermissionList(configDir, field, values);
  });
  ipcMain.handle('engram:get-coderepos', () => loadCodeRepos(configDir));
  ipcMain.handle('engram:set-code-alias', (_e, alias: string, targetPath: string) => setAlias(configDir, alias, targetPath));
  ipcMain.handle('engram:remove-code-alias', (_e, alias: string) => { removeAlias(configDir, alias); });
  ipcMain.handle('engram:set-search-roots', (_e, roots: string[]) => { setSearchRoots(configDir, roots); });
  ipcMain.handle('engram:list-schedules', () => listSchedules(configDir));
  ipcMain.handle('engram:remove-schedule', (_e, id: string) => removeScheduleFromFile(configDir, id));
  ipcMain.handle('engram:get-wiki-remote', () => readWikiRemoteFile(configDir));
  ipcMain.handle('engram:set-wiki-remote', (_e, cfg: WikiRemoteForm) => { saveWikiRemote(configDir, cfg); });
```

(BrainPatch·WikiRemoteForm 타입은 각 모듈에서 import.)

- [ ] **Step 2: preload.ts에 1:1 노출**:

```typescript
  listBrainDetails: () => ipcRenderer.invoke('engram:list-brain-details'),
  updateBrainProfile: (key: string, patch: Record<string, unknown>, newKey?: string) =>
    ipcRenderer.invoke('engram:update-brain-profile', key, patch, newKey),
  getPermissionDetails: () => ipcRenderer.invoke('engram:get-permission-details'),
  setPermissionList: (field: string, values: string[] | null) => ipcRenderer.invoke('engram:set-permission-list', field, values),
  getCodeRepos: () => ipcRenderer.invoke('engram:get-coderepos'),
  setCodeAlias: (alias: string, targetPath: string) => ipcRenderer.invoke('engram:set-code-alias', alias, targetPath),
  removeCodeAlias: (alias: string) => ipcRenderer.invoke('engram:remove-code-alias', alias),
  setSearchRoots: (roots: string[]) => ipcRenderer.invoke('engram:set-search-roots', roots),
  listSchedules: () => ipcRenderer.invoke('engram:list-schedules'),
  removeSchedule: (id: string) => ipcRenderer.invoke('engram:remove-schedule', id),
  getWikiRemote: () => ipcRenderer.invoke('engram:get-wiki-remote'),
  setWikiRemote: (cfg: { remote: string; branch: string; syncIntervalSec: number }) => ipcRenderer.invoke('engram:set-wiki-remote', cfg),
```

- [ ] **Step 3: 검증** — Run: `npm run build` clean → `npm test -- --testPathPattern="desktop"` PASS.
- [ ] **Step 4: 커밋** — `git add src/desktop/main.ts src/desktop/preload.ts; git commit -m "feat(settings-ui): IPC 12채널 + preload 노출(얇은 위임)"`

---

### Task 5: settings.html 골격 — 사이드바(타일·검색·펄스 상주) + 재스킨

**Files:**
- Modify: `src/desktop/settings.html` (레이아웃·CSS·nav·검색·기존 섹션 이사)
- Modify: `src/desktop/main.ts` (설정창 BrowserWindow 크기)

**Interfaces:**
- Consumes: 기존 `window.engram.status()` 폴링(refresh()).
- Produces: `<nav id="side">`·섹션 id 8종(`sec-status`·`sec-brain`·`sec-coding`·`sec-repos`·`sec-sched`·`sec-wiki`·`sec-messenger`·`sec-advanced`)·`showSection(id)`·`SECTION_LABELS`(검색 인덱스) — Task 6~8이 섹션 내부만 채움.

- [ ] **Step 1: 레이아웃 교체** — `<body>`를 `display:flex` 2단으로: 좌 `<nav id="side">`(고정 170px, `--panel-2` 배경, 세로 flex) + 우 `<main id="content">`(flex:1, overflow-y:auto, 패딩 22px 26px). 기존 `<header>`는 nav 상단으로 이동(Engram 워드마크+Settings 부제). nav 구조:

```html
<nav id="side">
  <div class="side-head"><span class="wordmark">Engram</span><span class="side-sub" data-t="tagline2"></span></div>
  <input id="nav-search" type="search" />
  <div id="nav-items">
    <button class="nav-item on" data-sec="sec-status"><span class="tile" style="background:#56d364"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 8h3l2-5 3 10 2-5h3"/></svg></span><span data-t="secStatus"></span></button>
    <button class="nav-item" data-sec="sec-brain"><span class="tile" style="background:#3aa5de"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/><path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2"/></svg></span><span data-t="secBrain"></span></button>
    <button class="nav-item" data-sec="sec-coding"><span class="tile" style="background:#7f77dd"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 4-3.5 4L5 12M11 4l3.5 4L11 12"/></svg></span><span data-t="secCoding"></span></button>
    <button class="nav-item" data-sec="sec-repos"><span class="tile" style="background:#ba7517"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 2h6a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z"/></svg></span><span data-t="secRepos"></span></button>
    <button class="nav-item" data-sec="sec-sched"><span class="tile" style="background:#d4537e"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg></span><span data-t="secSched"></span></button>
    <button class="nav-item" data-sec="sec-wiki"><span class="tile" style="background:#1d9e75"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 11.5a3 3 0 1 1 .4-5.97 4 4 0 0 1 7.6 1.2 2.5 2.5 0 0 1-.5 4.77z"/><path d="M8 13.5V9m0 0-1.8 1.8M8 9l1.8 1.8"/></svg></span><span data-t="secWiki"></span></button>
    <button class="nav-item" data-sec="sec-messenger"><span class="tile" style="background:#5865f2"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5h12v8H6l-3 2.5v-2.5H2z"/></svg></span><span>Discord</span></button>
    <button class="nav-item" data-sec="sec-advanced"><span class="tile" style="background:#888780"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5h12M2 11h12"/><circle cx="6" cy="5" r="1.6" fill="#fff"/><circle cx="10" cy="11" r="1.6" fill="#fff"/></svg></span><span data-t="secAdvanced"></span></button>
  </div>
  <div class="side-foot"><span class="pulse" id="side-pulse"></span><span id="side-status"></span><span id="side-up" class="mono"></span></div>
</nav>
```

- [ ] **Step 2: CSS 추가/조정** — 기존 `:root` 팔레트·pulse keyframes 유지, 추가:

```css
body { display: flex; padding: 0; height: 100vh; overflow: hidden; }
#side { width: 170px; flex: none; background: var(--panel-2); border-right: 1px solid var(--line); padding: 14px 8px 10px; display: flex; flex-direction: column; }
.side-head { padding: 0 10px 10px; }
.wordmark { font: 600 15px "Segoe UI Variable Display", "Segoe UI", sans-serif; letter-spacing: .3px; display: block; }
.side-sub { font-size: 11px; color: var(--muted); }
#nav-search { width: 100%; font-size: 12px; padding: 5px 9px; border-radius: 7px; margin-bottom: 10px; }
#nav-items { display: flex; flex-direction: column; gap: 1px; overflow-y: auto; }
.nav-item { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 9px; padding: 6px 10px; border-radius: 8px; font-size: 13px; color: var(--text); width: 100%; }
.nav-item:hover { background: color-mix(in srgb, var(--muted) 12%, transparent); }
.nav-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.nav-item.on { background: var(--accent); color: var(--accent-text); }
.tile { width: 22px; height: 22px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.side-foot { margin-top: auto; padding: 8px 10px 0; border-top: 1px solid var(--line); display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--muted); }
.side-foot .pulse { width: 8px; height: 8px; }
.side-foot #side-up { margin-left: auto; font-size: 10.5px; }
#content { flex: 1; overflow-y: auto; padding: 22px 26px; min-width: 0; }
#content > section { display: none; background: none; border: none; padding: 0; margin: 0 0 8px; }
#content > section.on { display: block; }
section h2 { font: 500 19px "Segoe UI Variable Display", "Segoe UI", sans-serif; letter-spacing: .2px; text-transform: none; color: var(--text); margin: 0 0 14px; }
.grp-h { font-size: 12px; color: var(--muted); margin: 16px 14px 6px; }
.grp { background: var(--panel); border: 1px solid var(--line); border-radius: 11px; overflow: hidden; }
.li { display: flex; align-items: center; gap: 10px; padding: 10px 14px; }
.li + .li, .li + .li-form, .li-form + .li { border-top: 1px solid var(--line); }
.li .val { margin-left: auto; display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
.li .val input, .li .val select { border: none; background: transparent; text-align: right; padding: 3px 4px; }
.li .val input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 4px; }
.cap { font-size: 12px; color: var(--muted); margin: 6px 14px 0; line-height: 1.5; }
.minus { width: 17px; height: 17px; border-radius: 50%; background: var(--dead); color: #fff; border: none; padding: 0; display: inline-flex; align-items: center; justify-content: center; flex: none; cursor: pointer; font-size: 12px; line-height: 1; }
.add-row { color: var(--accent); cursor: pointer; }
.chev { color: var(--muted); opacity: .6; }
```

(`section h2`가 기존 대문자 스타일을 덮으므로 기존 `section h2` 규칙은 삭제. 기존 `section` 카드 스타일은 `.grp`로 계승 — 기존 섹션 내부의 직접 자식 마크업은 이 태스크에서 `.grp`/`.li` 문법으로 감싸 재스킨하되 **id·이벤트 배선 무변경**.)

- [ ] **Step 3: JS — 섹션 전환·검색·펄스 상주**. 스크립트에 추가(기존 `t` 객체 아래):

```javascript
    // 섹션 전환
    function showSection(id) {
      document.querySelectorAll('#content > section').forEach((s) => s.classList.toggle('on', s.id === id));
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('on', b.dataset.sec === id));
    }
    document.querySelectorAll('.nav-item').forEach((b) => { b.onclick = () => showSection(b.dataset.sec); });
    showSection('sec-status');

    // 검색: 섹션명+설정 라벨 부분일치 → 일치 섹션만 표시
    const SECTION_LABELS = {
      'sec-status': [t.secStatus, t.lastBeat, t.embedModel, t.dataFolder, t.restart, t.refresh, t.showLogs],
      'sec-brain': [t.secBrain, t.defaultBrain, t.addBrain, t.setDefault, 'Ollama', 'API', t.saveKey],
      'sec-coding': [t.secCoding, t.cmdMode, t.writePaths, t.denyPaths, t.cmdAllowlist],
      'sec-repos': [t.secRepos, t.aliases, t.searchRoots],
      'sec-sched': [t.secSched, 'cron'],
      'sec-wiki': [t.secWiki, t.wikiRemote, t.wikiBranch, t.wikiInterval],
      'sec-messenger': ['Discord', t.save],
      'sec-advanced': [t.secAdvanced, t.openData, t.openLogs, t.openConfig],
    };
    $('nav-search').placeholder = t.search;
    $('nav-search').oninput = () => {
      const q = $('nav-search').value.trim().toLowerCase();
      document.querySelectorAll('.nav-item').forEach((b) => {
        const hit = !q || (SECTION_LABELS[b.dataset.sec] || []).some((l) => String(l).toLowerCase().includes(q));
        b.hidden = !hit;
      });
    };
```

`refresh()` 끝에 사이드바 생존 신호 갱신 추가:

```javascript
      $('side-pulse').classList.toggle('alive', s.alive);
      $('side-status').textContent = s.alive ? t.running : t.notResponding;
      $('side-up').textContent = s.lastBeat ? new Date(s.lastBeat).toLocaleTimeString() : '';
```

- [ ] **Step 4: i18n 추가** — `t` 두 벌에: ko `tagline2: '설정', search: '검색', secRepos: '코딩 프로젝트', secSched: '예약', secWiki: '위키 동기화', writePaths: '쓰기 허용 경로', denyPaths: '거부 경로', cmdAllowlist: '명령 허용 목록', aliases: '별칭', searchRoots: '검색 루트', wikiRemote: '원격 주소', wikiBranch: '브랜치', wikiInterval: '동기화 주기(초)'` / en `tagline2: 'Settings', search: 'Search', secRepos: 'Code repos', secSched: 'Schedules', secWiki: 'Wiki sync', writePaths: 'Write paths', denyPaths: 'Deny paths', cmdAllowlist: 'Command allowlist', aliases: 'Aliases', searchRoots: 'Search roots', wikiRemote: 'Remote', wikiBranch: 'Branch', wikiInterval: 'Sync interval (sec)'`. (Task 6~8이 쓸 키는 각 태스크에서 추가.)

- [ ] **Step 5: 신규 빈 섹션 3개 추가** — `<main id="content">` 안에 `<section id="sec-repos"><h2 data-t="secRepos"></h2></section>`·`<section id="sec-sched"><h2 data-t="secSched"></h2></section>`·`<section id="sec-wiki"><h2 data-t="secWiki"></h2></section>` (내용은 Task 7·8). 기존 5개 섹션은 `<main>` 안으로 이사, 각 `h2`는 유지.

- [ ] **Step 6: 설정창 크기** — main.ts 설정창 BrowserWindow에 `width: 760, height: 560, minWidth: 640, minHeight: 480` 지정.

- [ ] **Step 7: 검증** — `npm run build` clean, `npm test` PASS(렌더러 테스트 없음 — 회귀만). 가능하면 Electron 실행해 사이드바 전환·검색 확인, 불가면 미검증 보고.
- [ ] **Step 8: 커밋** — `git add src/desktop/settings.html src/desktop/main.ts; git commit -m "feat(settings-ui): 사이드바 골격 — 색 타일 8종(인라인 SVG)·검색·펄스 상주·인셋 리스트 CSS·기존 섹션 이사"`

---

### Task 6: Brain 섹션 — 인셋 리스트 + 드릴다운 편집

**Files:**
- Modify: `src/desktop/settings.html` (sec-brain 내부 + 스크립트 + i18n)

**Interfaces:**
- Consumes: `window.engram.listBrainDetails()`(BrainDetail[])·`updateBrainProfile(key, patch, newKey?)→boolean`·기존 `removeBrain`·`addOllama`·`slugModel`·`saveApiKey`·`listBrains`·`setDefaultBrain`·`detectOllama`. Task 5의 `.grp`/`.li` CSS.
- Produces: 완성된 Brain 섹션. `loadBrains()`는 상세 목록+드롭다운 둘 다 갱신하는 형태로 확장.

- [ ] **Step 1: 마크업** — `sec-brain`을 스펙 §3.3 구조로 재구성: "Registered brains" 그룹(`#brain-list`, JS 렌더) + 캡션 + "Add" 그룹(기존 ollama-add 줄·apikey 줄을 `.li` 문법으로 이사, id·핸들러 유지) + Default brain `.li` 줄(기존 select 유지).

- [ ] **Step 2: 목록 렌더 JS** — `loadBrains()`를 확장: `listBrainDetails()`로 그룹 렌더 — 줄마다 타일(하늘=engram 하네스 `/api$/`, 회색=CLI)+이름(mono)+모델(muted), 오른쪽 default 체크마크(✓ + t.defaultBadge) 또는 체브론 `›`. 줄 클릭 → 해당 key 인라인 편집 폼 토글(`editingKey` 상태 하나, 열려 있으면 닫고 새로 열기). 편집 폼(`.li-form`, `--panel-2` 배경)은 줄들: Name(mono input)·Model·Base URL·API key(password, placeholder=t.keepBlank, 라벨에 hasApiKey ? t.keySet : t.keyNotSet)·Max tokens·Web search(select: 빈/duckduckgo/brave/tavily)·Search API key(password, 동일 규칙)·$/M in·$/M out·[Delete(빨강, default면 disabled+title=t.defaultLocked)] [Cancel] [Save]. Save 수집 규칙(Task 1 계약 그대로): 텍스트 → 그대로(''=제거), 키 필드 → 비면 patch에서 제외, 숫자 → `''`→null, 아니면 Number(비정상은 undefined로 제외). `updateBrainProfile` false면 `t.nameConflict` 표시. 성공 시 폼 닫고 `loadBrains()` 재호출 + t.added 힌트. 전부 textContent/createElement — innerHTML 금지.

- [ ] **Step 3: i18n 추가** — ko: `keepBlank: '비워두면 기존 키 유지', keySet: '설정됨', keyNotSet: '없음', nameConflict: '같은 이름이 이미 있어요', delBrain: '삭제', cancel: '취소', brainCap: '기본 두뇌가 모든 채팅에 답합니다 — 다른 두뇌는 채팅에서 이름으로 부를 수 있어요.', addGroup: '추가', regGroup: '등록된 두뇌'` / en: `keepBlank: 'Leave blank to keep', keySet: 'set', keyNotSet: 'not set', nameConflict: 'That name already exists', delBrain: 'Delete', cancel: 'Cancel', brainCap: 'The default brain answers every chat — others can be called by name.', addGroup: 'Add', regGroup: 'Registered brains'`.

- [ ] **Step 4: 검증** — `npm run build` clean·`npm test` PASS. 가능하면 Electron 스모크(편집 저장→brains.json 반영·이름변경·키 보존), 불가면 미검증 보고.
- [ ] **Step 5: 커밋** — `git add src/desktop/settings.html; git commit -m "feat(settings-ui): Brain 섹션 — 드릴다운 편집(이름변경·키 미전송 보존)·Add 그룹·인셋 문법"`

---

### Task 7: Coding 권한 상세 + Code repos 섹션

**Files:**
- Modify: `src/desktop/settings.html` (sec-coding 확장 + sec-repos 신설 + i18n)

**Interfaces:**
- Consumes: `getPermissionDetails()`·`setPermissionList(field, values)`·`getCodeRepos()`·`setCodeAlias`·`removeCodeAlias`·`setSearchRoots`·기존 `pickFolder`(preload에 이미 있는지 확인 — 없으면 `engram:pick-folder` invoke를 preload에 `pickFolder: () => ipcRenderer.invoke('engram:pick-folder')`로 추가).
- Produces: 완성된 두 섹션.

- [ ] **Step 1: Coding 섹션** — 기존 cmd-mode `.li` 줄 아래에 그룹 3개(writePaths·denyPaths·commands). 공용 렌더 함수 하나:

```javascript
    // 목록 그룹 렌더(⊖줄 + ＋Add줄). getList/setList는 async, addFn은 값 하나를 얻는 함수(경로=pickFolder, 명령=prompt식 인라인 input).
    function renderListGroup(elId, items, onRemove, addLabel, onAdd) {
      const grp = $(elId);
      grp.textContent = '';
      for (const item of items) {
        const row = document.createElement('div'); row.className = 'li';
        const minus = document.createElement('button'); minus.className = 'minus'; minus.textContent = '−';
        minus.setAttribute('aria-label', t.remove + ' ' + item);
        minus.onclick = () => onRemove(item);
        const label = document.createElement('span'); label.className = 'mono'; label.style.fontSize = '12.5px'; label.textContent = item;
        row.append(minus, label); grp.appendChild(row);
      }
      const add = document.createElement('div'); add.className = 'li add-row'; add.textContent = '＋ ' + addLabel;
      add.onclick = onAdd; grp.appendChild(add);
    }
```

writePaths/denyPaths: `onAdd = async () => { const p = await window.engram.pickFolder(); if (p) { list.push(p); await setPermissionList(field, list); reload(); } }`. commands: Add 클릭 시 add-row를 인라인 input으로 교체(Enter=추가·Esc=취소). commands 그룹엔 "기본값으로 되돌리기" 줄 추가(`setPermissionList('commands', null)`) — commands가 null이면 되돌리기 줄 숨기고 캡션에 t.cmdBuiltin 표시. 각 그룹 캡션: writePaths 빈 상태=t.autoModeHint, commands=t.cmdListCap. 변경마다 "Restart to apply" 힌트(t.saved 재사용).

- [ ] **Step 2: Code repos 섹션** — Aliases 그룹: 줄=⊖+alias(mono)+경로(muted, ellipsis), Add 줄 클릭 → 인라인 폼(alias input + Browse 버튼(pickFolder)+Add). `setCodeAlias` false(빈 값)면 무시. Search roots 그룹: renderListGroup 재사용(`setSearchRoots(전체 배열)`). 캡션: t.aliasCap("채팅에서 'engram 고쳐줘'의 그 이름").

- [ ] **Step 3: i18n** — ko: `remove: '제거', addFolder: '폴더 추가', addCommand: '명령 추가', resetDefault: '기본값으로 되돌리기', cmdBuiltin: '지정 안 함 — 내장 기본 목록 사용 중', cmdListCap: '제한 모드일 때만 적용돼요. 비우면 전부 거부.', autoModeHint: '비어 있음 = 자동 모드(시스템 폴더 밖 허용)', aliasCap: "채팅에서 'engram 고쳐줘'라고 부를 때의 그 이름이에요.", rootsCap: '별칭에 없으면 이 폴더들에서 이름으로 찾아요.'` / en: `remove: 'Remove', addFolder: 'Add folder', addCommand: 'Add command', resetDefault: 'Reset to built-in defaults', cmdBuiltin: 'Not set — using the built-in list', cmdListCap: 'Applies in Restricted mode only. Empty = deny all.', autoModeHint: 'Empty = auto mode (allowed outside system folders)', aliasCap: 'The name you use in chat — "fix engram".', rootsCap: 'Folders searched by name when no alias matches.'`.

- [ ] **Step 4: 검증** — `npm run build`·`npm test` PASS. Electron 스모크 가능하면 permissions.json/coderepos.json 반영 확인.
- [ ] **Step 5: 커밋** — `git add src/desktop/settings.html src/desktop/preload.ts; git commit -m "feat(settings-ui): 권한 상세(3그룹·commands 3상태)+Code repos 섹션(별칭·검색루트)"`

---

### Task 8: Schedules + Wiki sync 섹션 + 수동 스모크 체크리스트

**Files:**
- Modify: `src/desktop/settings.html` (sec-sched·sec-wiki 내용 + i18n)

**Interfaces:**
- Consumes: `listSchedules()`·`removeSchedule(id)`·`getWikiRemote()`·`setWikiRemote(cfg)`.
- Produces: 완성 섹션 + 플랜 말미 수동 체크리스트 수행 결과.

- [ ] **Step 1: Schedules** — 그룹: 줄=⊖+cron(mono·accent색)+task(ellipsis)+channelId/once(muted, flex:none). ⊖ 클릭 → `removeSchedule(id)` → 목록 재로드 + **"Restart to apply" 강조**(스펙 §3.6 경합 — t.schedRestart를 accent색으로). 빈 목록 문구 t.schedEmpty. 캡션 t.schedCap.
- [ ] **Step 2: Wiki sync** — 그룹: Remote(mono input)·Branch(mono input)·Sync interval(sec, number input)·Save 줄. Save → `setWikiRemote({remote, branch, syncIntervalSec: Number(...)})` → t.saved 힌트. 캡션 t.wikiCap.
- [ ] **Step 3: i18n** — ko: `schedEmpty: '예약이 없어요', schedCap: "새 예약은 채팅에서 — '매일 아침 9시에 브리핑해줘'", schedRestart: '삭제는 재시작해야 완전히 적용돼요', wikiCap: '비우면 로컬 전용 · 인증은 git 표준(SSH/토큰) · ENGRAM_WIKI_REMOTE 환경변수가 있으면 그게 우선이에요'` / en: `schedEmpty: 'No schedules', schedCap: 'Create schedules in chat — "brief me every morning at 9"', schedRestart: 'Deletion fully applies after a restart', wikiCap: 'Empty = local only · auth is standard git (SSH/token) · the ENGRAM_WIKI_REMOTE env var wins if set'`.
- [ ] **Step 4: 최종 검증** — `npm run build` clean → `npm test` 전체 PASS. **수동 스모크 체크리스트**(Electron 실행 가능 시 — 불가면 각 항목 "미검증" 명시 보고):
  1. 사이드바 8항목 전환·검색("wiki" 입력→Wiki sync만 남음)·펄스 상주
  2. Brain: 편집 열기→이름변경 저장→brains.json 확인, API키 있는 프로필 편집 저장→키 보존 확인
  3. Coding: 경로 추가/제거→permissions.json 반영, commands 되돌리기→필드 삭제
  4. Code repos: 별칭 추가→coderepos.json, Schedules: 삭제→schedules.json
  5. Wiki: 저장→wiki-remote.json, 다크 모드 전환 확인
- [ ] **Step 5: 커밋** — `git add src/desktop/settings.html; git commit -m "feat(settings-ui): Schedules(목록·삭제·재시작 강조)+Wiki sync 폼 — 전면 UI화 완성"`

---

## Self-Review 결과

- 스펙 커버리지: §3.2→Task 5, §3.3→Task 1+6, §3.4→Task 2+7, §3.5→Task 3+7, §3.6→Task 3+8, §3.7→Task 3+8, §3.8→Task 4. 검색·펄스 상주·타일 8종=Task 5. 갭 없음.
- 시그니처 일관성: BrainDetail/BrainPatch/PermissionDetails/WikiRemoteForm — Task 1~4와 6~8 소비부 대조 완료. preload 이름(camelCase)과 IPC 채널(kebab) 매핑 명시.
- 플랜 코드는 Task 1~4 완전, Task 5~8은 구조·핸들러·i18n 완전 + 렌더 로직은 계약(수집 규칙·상태 규칙)으로 고정 — UI 태스크는 sonnet 배정 전제.
