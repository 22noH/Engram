import * as fs from 'fs/promises';
import * as path from 'path';
import type { WikiRemoteConfig } from '../../knowledge-core/wiki/wiki-remote.config';
import { WikiSyncService, WikiSyncOutcome } from '../wiki-sync.service';
import type { McpDeps } from './engram-mcp';

// 헤드리스 MCP(mcp-headless.ts 코어 모드)의 위키 git 원격 동기화 배선.
//
// ★왜 별도 배선인가: 동기화 자체(WikiGit + WikiSyncService)는 이미 있지만 main.ts(=앱/서버)에서만
// 배선돼 있었다 — 클로드/코덱스가 앱 없이 헤드리스로 위키에 저장하면 로컬 커밋만 쌓이고 원격엔
// 영영 안 올라갔다. 여기서 같은 구현을 재사용해 헤드리스에도 얹는다(새 동기화 로직 없음).
//
// ★상주와 다른 점 3가지:
//  1) 주기 타이머 없음. 헤드리스는 MCP 클라이언트 세션에 붙어 사는 프로세스라 수명이 들쭉날쭉하고,
//     플러그인 세션마다 스폰돼 6개+가 동시에 뜬다(2026-07-19 실사고 주석 참조). 그런 프로세스 N개가
//     60초마다 같은 저장소에 git을 때리면 이득 없이 경합만 는다. 대신 **시작 시 1회 pull/push +
//     실제 쓰기 직후 push**만 한다(WikiSyncService.start({periodic:false}) 재사용).
//  2) 브리지 모드면 아예 안 돈다. 앱이 떠 있으면 헤드리스는 앱의 /mcp로 브리지되고 동기화는 앱이
//     담당한다 — 여기서 또 돌면 같은 저장소를 두 프로세스가 동시에 만진다(mode 게이트).
//  3) 크로스 프로세스 파일 락. 같은 데이터 폴더를 여러 헤드리스(+뒤늦게 뜬 앱)가 공유하므로
//     in-process 직렬화(WikiGit.serialize)만으론 부족하다 — digest-lock.ts와 같은 결의 'wx' 파일 락.
//
// ★함정 회피: cfg(=config/wiki-remote.json의 원격)가 없으면 이 모듈은 **아무것도 만들지 않는다**.
// 팩토리가 null을 반환하고 호출자는 기존 deps를 그대로 쓴다 — 락 파일도, ensureRemote(.git/config
// 쓰기)도 발생하지 않는다("읽기 전용이어야 할 경로가 파일을 쓰지 않게" — 레포 사고 기록).

// WikiGit의 원격 표면(구조적 타입 — 순환 import 회피, wiki-sync.service.ts와 동일 결).
export interface HeadlessSyncGit {
  ensureRemote(url: string): Promise<void>;
  pull(branch: string): Promise<{ ok: boolean; conflict: boolean }>;
  push(branch: string): Promise<{ ok: boolean; conflict: boolean }>;
}

export interface HeadlessWikiSyncOptions {
  mode: 'core' | 'bridge';       // 'bridge'면 앱이 동기화 담당 → 배선 안 함
  cfg: WikiRemoteConfig | null;  // null(=원격 미설정)이면 완전 무동작
  git: HeadlessSyncGit;
  stateDir: string;              // 락 파일 위치(<data>/state/wiki-sync.lock)
  log?: (msg: string) => void;   // stderr 전용(stdout은 MCP 와이어)
  timeoutMs?: number;
  lockWaitMs?: number;
  lockRetryMs?: number;
  lockStaleMs?: number;
}

export interface HeadlessWikiSync {
  // 시작 시 1회: ensureRemote + pull/push. never-throw(실패는 로그).
  start(): Promise<WikiSyncOutcome>;
  // 쓰기 도구(wiki_write/approve_proposal) 뒤에 push를 붙인 deps를 돌려준다.
  wrap(deps: McpDeps): McpDeps;
}

const DEFAULT_TIMEOUT_MS = 30_000;   // 도구 응답이 git 행(hang)에 물려 영영 안 돌아오는 것 방지
const DEFAULT_LOCK_WAIT_MS = 5_000;  // 다른 프로세스가 동기화 중이면 이만큼 기다렸다 포기
const DEFAULT_LOCK_RETRY_MS = 200;
const DEFAULT_LOCK_STALE_MS = 5 * 60_000; // 크래시 잔여 락 탈취(digest-lock.ts와 같은 결)

const LOCK_FILE = 'wiki-sync.lock';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// fn이 ms 안에 안 끝나면 null. (git이 자격증명 프롬프트 등으로 행이면 도구 호출을 인질로 잡지 않는다.)
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function makeHeadlessWikiSync(opts: HeadlessWikiSyncOptions): HeadlessWikiSync | null {
  // 브리지(=앱 상주) → 동기화는 앱 몫. 중복 실행하지 않는다.
  if (opts.mode !== 'core') return null;
  // 원격 미설정 → 완전 무동작(회귀 0).
  if (!opts.cfg) return null;

  const cfg = opts.cfg;
  const log = opts.log ?? ((): void => {});
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lockWaitMs = opts.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const lockRetryMs = opts.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
  const lockStaleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const lockPath = path.join(opts.stateDir, LOCK_FILE);

  // 동기화 구현 재사용 — 여기선 새 로직을 만들지 않는다(pull/push/충돌 처리는 전부 이쪽).
  const svc = new WikiSyncService(opts.git, cfg, { warn: (m) => log(m) });

  // 같은 프로세스 안 직렬화(WikiGit.serialize와 같은 결) — 시작 동기화와 쓰기 후 동기화가 겹치지 않게.
  // ★파일 락 대신 이걸 먼저 두는 이유: syncOnce의 재진입 가드는 "겹치면 건너뜀"이라 쓰기 후 push가
  // 조용히 사라질 수 있다. 큐로 세우면 건너뛰지 않고 순서대로 실제 실행된다.
  let chain: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  }

  async function tryAcquireLock(): Promise<boolean> {
    try {
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(lockPath, `${process.pid} ${new Date().toISOString()}`, { flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > lockStaleMs) {
          await fs.rm(lockPath, { force: true });
          await fs.writeFile(lockPath, `${process.pid} ${new Date().toISOString()}`, { flag: 'wx' });
          return true;
        }
      } catch {
        // stat/재생성 경합 → 점유 중으로 간주
      }
      return false;
    }
  }

  async function acquireLock(): Promise<boolean> {
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      if (await tryAcquireLock()) return true;
      if (Date.now() >= deadline) return false;
      await delay(lockRetryMs);
    }
  }

  // 락 + 타임아웃 + never-throw로 감싼 실행. 실패는 사유를 남기고 삼킨다(도구 호출을 죽이지 않는다).
  async function guarded(label: string, fn: () => Promise<WikiSyncOutcome>): Promise<WikiSyncOutcome> {
    if (!(await acquireLock())) {
      const r: WikiSyncOutcome = { ok: false, reason: 'another Engram process is syncing the wiki right now' };
      log(`[wiki-sync] ${label}: ${r.reason}`);
      return r;
    }
    let outcome: WikiSyncOutcome;
    try {
      outcome = (await withTimeout(fn(), timeoutMs)) ?? { ok: false, reason: `timed out after ${timeoutMs}ms` };
    } catch (e) {
      outcome = { ok: false, reason: `sync error: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
    if (!outcome.ok) log(`[wiki-sync] ${label} failed: ${outcome.reason ?? 'unknown'}`);
    return outcome;
  }

  const run = (label: string, fn: () => Promise<WikiSyncOutcome>): Promise<WikiSyncOutcome> =>
    serialize(() => guarded(label, fn));

  // 실패 사유를 도구 응답 꼬리에 붙인다 — 조용한 실패 금지(사용자가 "저장됐다"만 보고 원격에 없는
  // 상황을 모르는 일이 없게). 성공하면 아무것도 덧붙이지 않는다.
  function note(o: WikiSyncOutcome): string {
    if (o.ok) return '';
    return `\n\n(note: saved locally, but the wiki git remote sync failed — ${o.reason ?? 'unknown reason'}. ` +
      'It will be retried on the next write or when the Engram app runs.)';
  }

  return {
    start: () => run('startup', () => svc.start({ periodic: false })),

    wrap(deps: McpDeps): McpDeps {
      const out: McpDeps = { ...deps };
      // wiki_write — 즉시 게시(로컬 커밋 발생) → pull/push.
      if (deps.write) {
        const inner = deps.write;
        out.write = async (input) => `${await inner(input)}${note(await run('wiki_write', () => svc.syncOnce()))}`;
      }
      // approve_proposal — 제안이 실제 위키 페이지로 적용되는 지점(로컬 커밋 발생) → pull/push.
      // ★wiki_propose는 감싸지 않는다: 제안은 <data>/state/proposals/*.json에 저장되고 위키 git
      // 저장소(<data>/wiki)를 건드리지 않는다 — push할 커밋이 없으니 네트워크만 낭비된다.
      // reject도 같은 이유로 제외(위키 파일 변경 없음).
      if (deps.proposals) {
        const p = deps.proposals;
        out.proposals = {
          list: () => p.list(),
          approve: async (id) => `${await p.approve(id)}${note(await run('approve_proposal', () => svc.syncOnce()))}`,
          reject: (id) => p.reject(id),
        };
      }
      return out;
    },
  };
}
