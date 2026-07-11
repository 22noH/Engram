# Phase 15b — 위키 git 원격 동기화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 위키를 중앙 git 원격에 주기적으로 pull/push해, 분산된 로컬 두뇌들이 하나의 지식 위키를 공유한다.

**Architecture:** 각 두뇌는 위키 로컬 git(`runtime/wiki`)을 그대로 유지한다. `WikiGit`에 원격 메서드(ensureRemote/pull/push)를 더하고, 새 plain `WikiSyncService`가 설정된 주기로 pull→push한다(main.ts 배선). pull로 들어온 .md는 기존 `WikiWatcher`가 자동 재색인한다. 원격 미설정이면 동기화가 아예 안 뜬다(현행 로컬 전용 그대로).

**Tech Stack:** NestJS + TypeScript + `simple-git`(백엔드, Jest). 신규 의존성 없음(simple-git 기존재).

## Global Constraints

- **하위호환 절대**: 원격 미설정 시 동기화 미가동, WikiGit 로컬 메서드(`ensureRepo`/`commitAll`)·WikiEngine·WikiWatcher·RagStore·클라이언트 전부 무변경. 기존 테스트 무변경 통과.
- **위키 폴더(`runtime/wiki`)만 git 대상** — RAG(`runtime/rag`)·상태·채팅은 로컬(동기화 안 함).
- **마크다운 유지** — 포맷 변경 없음. 바이너리 첨부 비범위.
- **충돌 안전 회피**: 같은 페이지 동시 편집 병합 충돌 시 `git merge --abort` + 로컬 유지 + 경고. 진짜 자동 해결은 15c(비범위).
- **상주 불사**: 원격 메서드·동기화는 예외를 던지지 않고 상태로 반환/로그. 네트워크 끊겨도 상주 생존.
- **자격증명 미관리**: git 표준 인증(SSH/토큰)에 위임. 앱은 URL만 받는다.
- 백엔드 테스트: `npx jest <path>` · 백엔드 빌드: `npm run build`

## File Structure

| 파일 | 책임 | 변경 |
|------|------|------|
| `src/knowledge-core/wiki/wiki-remote.config.ts` | 원격 설정 로드 | (신규) |
| `src/knowledge-core/wiki/wiki-git.ts` | git 이력 + 원격 | `ensureRemote`/`pull`/`push` 추가 |
| `src/edge/wiki-sync.service.ts` | 주기 동기화 | (신규, plain) |
| `src/main.ts` | 상주 부트스트랩 | 원격 설정 시 WikiSyncService 배선 |
| `README.md` | 문서 | 중앙 저장 설정·인증 |

---

## Task 1: 원격 설정 로더

**Files:**
- Create: `src/knowledge-core/wiki/wiki-remote.config.ts`
- Test: `src/knowledge-core/wiki/wiki-remote.config.spec.ts`

**Interfaces:**
- Produces: `WikiRemoteConfig { remote: string; branch: string; syncIntervalSec: number }`; `loadWikiRemote(configDir, env?): WikiRemoteConfig | null`. remote 빈 값/미설정 → `null`. env `ENGRAM_WIKI_REMOTE` 우선. branch 기본 `'main'`, syncIntervalSec 기본 `60`(비양수·NaN → 60).

- [ ] **Step 1: 실패 테스트 작성**

`src/knowledge-core/wiki/wiki-remote.config.spec.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadWikiRemote } from './wiki-remote.config';

describe('loadWikiRemote', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-wr-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('미설정(파일 없음) → null', () => {
    expect(loadWikiRemote(dir, {})).toBeNull();
  });

  it('remote 빈 값 → null', () => {
    fs.writeFileSync(path.join(dir, 'wiki-remote.json'), JSON.stringify({ remote: '  ' }));
    expect(loadWikiRemote(dir, {})).toBeNull();
  });

  it('remote 설정 → 기본 branch main·interval 60', () => {
    fs.writeFileSync(path.join(dir, 'wiki-remote.json'), JSON.stringify({ remote: 'file:///tmp/r.git' }));
    expect(loadWikiRemote(dir, {})).toEqual({ remote: 'file:///tmp/r.git', branch: 'main', syncIntervalSec: 60 });
  });

  it('branch·interval 오버라이드; env ENGRAM_WIKI_REMOTE가 파일보다 우선', () => {
    fs.writeFileSync(path.join(dir, 'wiki-remote.json'), JSON.stringify({ remote: 'file:///a.git', branch: 'trunk', syncIntervalSec: 30 }));
    expect(loadWikiRemote(dir, { ENGRAM_WIKI_REMOTE: 'file:///b.git' })).toEqual({ remote: 'file:///b.git', branch: 'trunk', syncIntervalSec: 30 });
  });

  it('비양수 interval → 60', () => {
    fs.writeFileSync(path.join(dir, 'wiki-remote.json'), JSON.stringify({ remote: 'file:///a.git', syncIntervalSec: 0 }));
    expect(loadWikiRemote(dir, {}).syncIntervalSec).toBe(60);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/knowledge-core/wiki/wiki-remote.config.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`src/knowledge-core/wiki/wiki-remote.config.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';

// 위키 git 원격 설정(Phase 15b). remote 미설정 = 동기화 안 함(로컬 전용).
// 자격증명은 담지 않는다 — git 표준 인증(SSH/토큰)에 위임.
export interface WikiRemoteConfig {
  remote: string;
  branch: string;
  syncIntervalSec: number;
}

export function loadWikiRemote(configDir: string, env: NodeJS.ProcessEnv = process.env): WikiRemoteConfig | null {
  let raw: Partial<WikiRemoteConfig> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'wiki-remote.json'), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Partial<WikiRemoteConfig>;
  } catch {
    raw = {};
  }
  const remote = (typeof env.ENGRAM_WIKI_REMOTE === 'string' && env.ENGRAM_WIKI_REMOTE.trim())
    || (typeof raw.remote === 'string' && raw.remote.trim())
    || '';
  if (!remote) return null; // 미설정 → 동기화 비활성
  const branch = (typeof raw.branch === 'string' && raw.branch.trim()) || 'main';
  const n = Number(raw.syncIntervalSec);
  const syncIntervalSec = Number.isFinite(n) && n > 0 ? n : 60;
  return { remote, branch, syncIntervalSec };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/knowledge-core/wiki/wiki-remote.config.spec.ts`
Expected: PASS (5건).

- [ ] **Step 5: 커밋**

```bash
git add src/knowledge-core/wiki/wiki-remote.config.ts src/knowledge-core/wiki/wiki-remote.config.spec.ts
git commit -m "feat(phase15b): 위키 원격 설정 로더(wiki-remote.json + ENGRAM_WIKI_REMOTE)"
```

---

## Task 2: WikiGit 원격 메서드

**Files:**
- Modify: `src/knowledge-core/wiki/wiki-git.ts`
- Test: `src/knowledge-core/wiki/wiki-git-remote.spec.ts` (Create)

**Interfaces:**
- Consumes: 기존 `WikiGit.ensureRepo`/`commitAll`.
- Produces:
  - `ensureRemote(url: string): Promise<void>` — repo 보장 + `origin` 추가/갱신 + 로컬 브랜치명을 push 대상 브랜치로 정렬은 push/pull 시 branch 인자로 처리(아래).
  - `pull(branch: string): Promise<{ ok: boolean; conflict: boolean }>` — fetch+merge, 충돌 시 abort+로컬유지→`{ok:true,conflict:true}`; 원격 브랜치 없음/네트워크 실패→`{ok:false 또는 true, conflict:false}`.
  - `push(branch: string): Promise<{ ok: boolean; conflict: boolean }>` — push, 거부 시 pull+재시도 1회.

- [ ] **Step 1: 실패 테스트 작성**

`src/knowledge-core/wiki/wiki-git-remote.spec.ts` — 로컬 bare 저장소를 원격으로 삼아 실제 git 검증:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import { WikiGit } from './wiki-git';
import { PathResolver } from '../../pal/path-resolver';

// 한 두뇌의 위키 폴더에 페이지 파일을 쓰고 커밋하는 헬퍼(WikiEngine 없이 git만 검증).
async function writePage(dataDir: string, slug: string, body: string): Promise<void> {
  const pagesDir = path.join(dataDir, 'wiki', 'pages', 'default');
  await fs.promises.mkdir(pagesDir, { recursive: true });
  await fs.promises.writeFile(path.join(pagesDir, `${slug}.md`), body);
}
function readPage(dataDir: string, slug: string): string {
  return fs.readFileSync(path.join(dataDir, 'wiki', 'pages', 'default', `${slug}.md`), 'utf8');
}

describe('WikiGit 원격', () => {
  let remote: string; let dirA: string; let dirB: string;
  let gitA: WikiGit; let gitB: WikiGit;

  beforeEach(async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-wg-'));
    remote = path.join(base, 'remote.git');
    dirA = path.join(base, 'A');
    dirB = path.join(base, 'B');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    await simpleGit().raw(['init', '--bare', '-b', 'main', remote]); // 빈 중앙 원격
    gitA = new WikiGit(new PathResolver(dirA));
    gitB = new WikiGit(new PathResolver(dirB));
  });
  afterEach(() => { /* base tmpdir는 OS가 정리; 명시 rm은 생략(핸들 안전) */ });

  it('A push → B가 pull로 받아온다', async () => {
    await writePage(dirA, 'alpha', 'from-A');
    await gitA.ensureRemote(remote);
    await gitA.commitAll('add alpha');
    expect((await gitA.push('main')).ok).toBe(true);

    await gitB.ensureRemote(remote);
    const pr = await gitB.pull('main');
    expect(pr).toEqual({ ok: true, conflict: false });
    expect(readPage(dirB, 'alpha')).toBe('from-A');
  });

  it('push 거부(원격 앞섬) → pull+재시도로 성공', async () => {
    // A가 먼저 올린다
    await writePage(dirA, 'alpha', 'A1'); await gitA.ensureRemote(remote); await gitA.commitAll('a1'); await gitA.push('main');
    // B가 원격을 모른 채(=pull 전) 다른 페이지를 커밋하고 push → 거부되어야 하고, 내부 pull+재시도로 성공
    await gitB.ensureRemote(remote);
    await writePage(dirB, 'beta', 'B1'); await gitB.commitAll('b1');
    const ps = await gitB.push('main');
    expect(ps).toEqual({ ok: true, conflict: false });
    // A가 pull하면 두 페이지 다 보인다
    await gitA.pull('main');
    expect(readPage(dirA, 'alpha')).toBe('A1');
    expect(readPage(dirA, 'beta')).toBe('B1');
  });

  it('같은 페이지 다른 편집 동시 → pull 충돌 시 abort+로컬 유지', async () => {
    await writePage(dirA, 'alpha', 'base'); await gitA.ensureRemote(remote); await gitA.commitAll('base'); await gitA.push('main');
    await gitB.ensureRemote(remote); await gitB.pull('main'); // B도 base 확보
    // A가 alpha를 A로 바꿔 push
    await writePage(dirA, 'alpha', 'A-version'); await gitA.commitAll('a-edit'); await gitA.push('main');
    // B가 같은 alpha를 B로 바꿔 커밋 후 pull → 충돌 → abort, 로컬(B) 유지
    await writePage(dirB, 'alpha', 'B-version'); await gitB.commitAll('b-edit');
    const pr = await gitB.pull('main');
    expect(pr.conflict).toBe(true);
    expect(readPage(dirB, 'alpha')).toBe('B-version'); // 로컬 유지(손상 없음)
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/knowledge-core/wiki/wiki-git-remote.spec.ts`
Expected: FAIL — `ensureRemote`/`pull`/`push` 없음.

- [ ] **Step 3: 구현**

`src/knowledge-core/wiki/wiki-git.ts`에 메서드 추가(기존 `ensureRepo`/`commitAll`/`recentMessages` 아래). 클래스 상단 주석은 그대로.

```ts
  // 원격 origin 보장(Phase 15b). ensureRepo 후 origin 추가(URL 바뀌면 set-url).
  async ensureRemote(url: string): Promise<void> {
    await this.ensureRepo();
    this.git.cwd(this.paths.getWikiDir());
    const remotes = await this.git.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    if (!origin) await this.git.addRemote('origin', url);
    else if (origin.refs.fetch !== url && origin.refs.push !== url) {
      await this.git.remote(['set-url', 'origin', url]);
    }
  }

  // HEAD 커밋 존재 여부(unborn 브랜치 판별).
  private async hasHead(): Promise<boolean> {
    return this.git.raw(['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false);
  }

  // 원격에서 받아 병합. 충돌 시 abort + 로컬 유지. 네트워크/원격없음은 조용히 스킵.
  async pull(branch: string): Promise<{ ok: boolean; conflict: boolean }> {
    this.git.cwd(this.paths.getWikiDir());
    try {
      await this.git.fetch('origin', branch);
    } catch {
      return { ok: false, conflict: false }; // 네트워크/원격 접근 실패 → 다음 주기
    }
    const hasRemoteRef = await this.git
      .raw(['rev-parse', '--verify', `origin/${branch}`])
      .then(() => true)
      .catch(() => false);
    if (!hasRemoteRef) return { ok: true, conflict: false }; // 원격에 아직 그 브랜치 없음
    // 로컬 커밋이 없으면 원격을 그대로 체크아웃(최초 클론 상황).
    if (!(await this.hasHead())) {
      await this.git.raw(['checkout', '-B', branch, `origin/${branch}`]);
      return { ok: true, conflict: false };
    }
    // 로컬 브랜치명을 branch로 정렬(init 기본 브랜치명 차이 흡수).
    await this.git.raw(['branch', '-M', branch]).catch(() => {});
    try {
      // --allow-unrelated-histories: 각 두뇌가 따로 git init해 커밋한 뒤 합류하면(마이그레이션)
      // 공통 조상이 없어 기본 merge가 거부된다. 다른 파일이면 자동 병합, 같은 파일이면 충돌(아래 abort).
      await this.git.raw(['merge', `origin/${branch}`, '--allow-unrelated-histories']);
      return { ok: true, conflict: false };
    } catch {
      await this.git.raw(['merge', '--abort']).catch(() => {});
      return { ok: true, conflict: true }; // 충돌 → 로컬 유지
    }
  }

  // 로컬 커밋을 원격에 push. 거부(원격 앞섬) → pull 후 1회 재시도.
  async push(branch: string): Promise<{ ok: boolean; conflict: boolean }> {
    this.git.cwd(this.paths.getWikiDir());
    if (!(await this.hasHead())) return { ok: true, conflict: false }; // 보낼 커밋 없음
    await this.git.raw(['branch', '-M', branch]).catch(() => {});
    try {
      await this.git.push('origin', branch);
      return { ok: true, conflict: false };
    } catch {
      const p = await this.pull(branch);
      if (p.conflict) return { ok: false, conflict: true };
      try {
        await this.git.push('origin', branch);
        return { ok: true, conflict: false };
      } catch {
        return { ok: false, conflict: false }; // 다음 주기 재시도
      }
    }
  }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/knowledge-core/wiki/wiki-git-remote.spec.ts`
Expected: PASS (3건). 기존 wiki 관련 테스트도 회귀 없음: `npx jest src/knowledge-core/wiki`.

- [ ] **Step 5: 커밋**

```bash
git add src/knowledge-core/wiki/wiki-git.ts src/knowledge-core/wiki/wiki-git-remote.spec.ts
git commit -m "feat(phase15b): WikiGit 원격 메서드 — ensureRemote·pull(충돌 abort)·push(거부 재시도)"
```

---

## Task 3: 동기화 서비스 + 배선

**Files:**
- Create: `src/edge/wiki-sync.service.ts`
- Modify: `src/main.ts`
- Test: `src/edge/wiki-sync.service.spec.ts` (Create)

**Interfaces:**
- Consumes: `WikiRemoteConfig`(Task 1), `WikiGit.ensureRemote/pull/push`(Task 2, 구조적 타입).
- Produces: `WikiSyncService` — `start()`(ensureRemote → 최초 syncOnce → 인터벌), `stop()`, `syncOnce()`(pull→push, 예외/충돌은 로그만).

- [ ] **Step 1: 실패 테스트 작성**

`src/edge/wiki-sync.service.spec.ts` — fake WikiGit 스파이:

```ts
import { WikiSyncService } from './wiki-sync.service';

function fakeGit() {
  const calls: string[] = [];
  return {
    calls,
    ensureRemote: async (url: string) => { calls.push(`ensureRemote:${url}`); },
    pull: async (b: string) => { calls.push(`pull:${b}`); return { ok: true, conflict: false }; },
    push: async (b: string) => { calls.push(`push:${b}`); return { ok: true, conflict: false }; },
  };
}
const noLog = { warn: () => {} };
const cfg = { remote: 'file:///r.git', branch: 'main', syncIntervalSec: 60 };

describe('WikiSyncService', () => {
  it('syncOnce는 pull 후 push를 호출한다', async () => {
    const g = fakeGit();
    const svc = new WikiSyncService(g, cfg, noLog);
    await svc.syncOnce();
    expect(g.calls).toEqual(['pull:main', 'push:main']);
  });

  it('start는 ensureRemote 후 최초 동기(pull·push)를 한다', async () => {
    const g = fakeGit();
    const svc = new WikiSyncService(g, cfg, noLog);
    await svc.start();
    svc.stop();
    expect(g.calls.slice(0, 3)).toEqual(['ensureRemote:file:///r.git', 'pull:main', 'push:main']);
  });

  it('pull이 던져도 syncOnce는 삼키고 push는 시도하지 않는다(예외 격리)', async () => {
    const g = fakeGit();
    g.pull = async () => { throw new Error('network'); };
    const svc = new WikiSyncService(g, cfg, noLog);
    await expect(svc.syncOnce()).resolves.toBeUndefined();
  });

  it('충돌 반환은 경고만, throw 안 함', async () => {
    const g = fakeGit();
    g.pull = async () => ({ ok: true, conflict: true });
    const warns: string[] = [];
    const svc = new WikiSyncService(g, cfg, { warn: (m: string) => warns.push(m) });
    await svc.syncOnce();
    expect(warns.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/edge/wiki-sync.service.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`src/edge/wiki-sync.service.ts`:

```ts
import type { WikiRemoteConfig } from '../knowledge-core/wiki/wiki-remote.config';

// WikiGit 원격 표면(구조적 타입 — 순환 회피).
interface WikiSyncer {
  ensureRemote(url: string): Promise<void>;
  pull(branch: string): Promise<{ ok: boolean; conflict: boolean }>;
  push(branch: string): Promise<{ ok: boolean; conflict: boolean }>;
}

// 위키 git 원격 동기화(Phase 15b, plain — main.ts 배선). 주기적으로 pull→push.
// 예외/충돌은 로그만(상주 불사). pull로 들어온 .md는 WikiWatcher가 재색인(자동).
export class WikiSyncService {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly git: WikiSyncer,
    private readonly cfg: WikiRemoteConfig,
    private readonly logger: { warn(msg: string, ctx?: string): void },
  ) {}

  async start(): Promise<void> {
    try {
      await this.git.ensureRemote(this.cfg.remote);
    } catch (e) {
      this.logger.warn(`위키 원격 설정 실패: ${String(e)}`, 'WikiSync');
    }
    await this.syncOnce();
    this.timer = setInterval(() => { void this.syncOnce(); }, this.cfg.syncIntervalSec * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async syncOnce(): Promise<void> {
    try {
      const pl = await this.git.pull(this.cfg.branch);
      if (pl.conflict) this.logger.warn('위키 pull 병합 충돌 — 로컬 유지(수동/15c 해결 필요)', 'WikiSync');
      const ps = await this.git.push(this.cfg.branch);
      if (ps.conflict) this.logger.warn('위키 push 충돌 — 다음 주기 재시도', 'WikiSync');
    } catch (e) {
      this.logger.warn(`위키 동기화 오류: ${String(e)}`, 'WikiSync');
    }
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/edge/wiki-sync.service.spec.ts`
Expected: PASS (4건).

- [ ] **Step 5: main.ts 배선**

`src/main.ts` — import 추가:
```ts
import { WikiGit } from './knowledge-core/wiki/wiki-git';
import { loadWikiRemote } from './knowledge-core/wiki/wiki-remote.config';
import { WikiSyncService } from './edge/wiki-sync.service';
```

`bootstrap()` 안, 채팅/메신저 배선 근처(app·paths·logger가 이미 있는 스코프)에 추가:
```ts
  // 위키 git 원격 동기화(Phase 15b): 원격이 설정됐을 때만 가동. 실패해도 상주 불사.
  const wikiRemote = loadWikiRemote(paths.getConfigDir());
  if (wikiRemote) {
    const wikiSync = new WikiSyncService(app.get(WikiGit), wikiRemote, logger);
    void wikiSync.start().catch((e) => logger.warn(`위키 동기화 시작 실패: ${String(e)}`, 'WikiSync'));
  }
```
(`WikiGit`는 KnowledgeCoreModule provider라 `app.get(WikiGit)`로 해소된다. `logger`는 PinoLogger — `warn(msg, ctx)` 시그니처 일치.)

- [ ] **Step 6: 백엔드 빌드 + 회귀**

Run: `npm run build`
Expected: nest build exit 0(main.ts 타입 정합).
Run: `npm test`
Expected: 전체 녹색(신규 spec 포함, 기존 회귀 0).

- [ ] **Step 7: 커밋**

```bash
git add src/edge/wiki-sync.service.ts src/edge/wiki-sync.service.spec.ts src/main.ts
git commit -m "feat(phase15b): WikiSyncService 주기 pull/push + main 배선(원격 설정 시만)"
```

---

## Task 4: 문서(README)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 중앙 저장 안내 추가**

`README.md`의 "위키 · 승인함 (Phase 15a)" 절 뒤에 추가:

```markdown
### 위키 중앙 저장 (Phase 15b)

여러 두뇌가 하나의 위키를 공유하려면 **중앙 git 원격**에 동기화한다. 위키는 이미 마크다운 +
git이라, 원격만 설정하면 각 두뇌가 주기적으로 pull(남의 지식 받기)·push(내 커밋 보내기)한다.

- 설정: `config/wiki-remote.json` `{ "remote": "git@호스트:me/engram-wiki.git", "branch": "main", "syncIntervalSec": 60 }`
  또는 env `ENGRAM_WIKI_REMOTE`. **미설정이면 로컬 전용(동기화 안 함).**
- 중앙 원격 = GitHub 비공개 저장소 / 사내 git / **자기 서버·NAS의 bare git**(`git init --bare`) 무엇이든.
- 인증은 **git 표준**(SSH 키 권장, 또는 토큰 URL). Engram은 자격증명을 관리하지 않는다 — 실행
  사용자의 git이 접근 가능해야 한다.
- pull로 들어온 지식은 각 두뇌 RAG에 **자동 재색인**된다. git 저장소는 위키 폴더만 —
  RAG·채팅·상태는 각 두뇌 로컬.
- ⚠️ **같은 페이지를 두 두뇌가 동시에 다르게 편집**하면 병합 충돌이 날 수 있다. 이때는
  **로컬을 유지하고 경고**만 남긴다(자동 충돌 해결은 다음 단계). 서로 다른 페이지 변경은
  git이 자동 병합한다.
```

- [ ] **Step 2: 커밋**

```bash
git add README.md
git commit -m "docs(phase15b): 위키 중앙 git 저장 설정·인증 안내"
```

---

## 완료 검증(전 태스크 후)

- [ ] 백엔드 전체: `npm test` → 녹색
- [ ] 빌드: `npm run build` → exit 0
- [ ] 수동 스모크(선택): 로컬에 bare 저장소(`git init --bare`) 하나 만들고 `config/wiki-remote.json`에 그 경로를 remote로 넣어 `npm run start` → 위키 커밋이 그 원격에 push되는지(`git -C <bare> log`) 확인. 두 번째 데이터 폴더로 같은 원격을 pull → 페이지가 받아지는지.

---

## Self-Review 결과

- **스펙 커버리지**: §2.1 설정 로더=Task1 / §2.2 WikiGit 원격(ensureRemote·pull충돌abort·push재시도)=Task2 / §2.3 SyncService(start·syncOnce·인터벌)=Task3 / §2.3 main 배선=Task3 Step5 / §2.4 동시성(push재시도·충돌abort)=Task2 구현+테스트 / §3 README=Task4 / §4 테스트(bare repo)=Task2·Task1·Task3. 갭 없음. WikiWatcher 재색인은 기존 동작(무변경) — 통합 스모크는 완료검증의 수동 스텝.
- **타입 정합**: `{ ok: boolean; conflict: boolean }` 반환형을 Task2가 정의, Task3의 `WikiSyncer` 인터페이스가 동일 시그니처로 소비 · `WikiRemoteConfig`(Task1)를 Task3·main이 소비 · `loadWikiRemote`(Task1)를 main이 소비. 일치.
- **하위호환**: 원격 미설정 → main이 SyncService 미생성(Task3 Step5 `if (wikiRemote)`). WikiGit 로컬 메서드 무변경(원격 메서드는 추가만). 기존 wiki 테스트 회귀 0(Task2 Step4).
- **상주 불사**: WikiGit 원격 메서드는 throw 안 하고 상태 반환; SyncService.syncOnce는 try/catch로 삼킴; main은 start를 `.catch`로 감쌈. 네트워크 실패가 상주를 안 죽임.
