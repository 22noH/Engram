import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { makeHeadlessWikiSync, HeadlessWikiSyncOptions } from './headless-wiki-sync';
import type { McpDeps } from './engram-mcp';

const CFG = { remote: 'file:///r.git', branch: 'main', syncIntervalSec: 60 };

function fakeGit() {
  const calls: string[] = [];
  return {
    calls,
    ensureRemote: async (url: string) => { calls.push(`ensureRemote:${url}`); },
    pull: async (b: string) => { calls.push(`pull:${b}`); return { ok: true, conflict: false }; },
    push: async (b: string) => { calls.push(`push:${b}`); return { ok: true, conflict: false }; },
  };
}

// 도구 호출 흔적을 남기는 최소 McpDeps(위키 엔진 없이 wrap 계약만 검증).
function fakeDeps() {
  const calls: string[] = [];
  const deps: McpDeps = {
    search: async () => [],
    read: async () => null,
    list: async () => [],
    propose: async () => { calls.push('propose'); return 'p1'; },
    askBrain: null,
    brainNames: () => [],
    proposals: {
      list: async () => [],
      approve: async (id: string) => { calls.push(`approve:${id}`); return `approved proposal ${id}`; },
      reject: async (id: string) => { calls.push(`reject:${id}`); return `rejected proposal ${id}`; },
    },
    write: async ({ title }) => { calls.push(`write:${title}`); return 'created t'; },
  };
  return { deps, calls };
}

describe('makeHeadlessWikiSync', () => {
  let stateDir: string;
  const base = (over: Partial<HeadlessWikiSyncOptions> = {}): HeadlessWikiSyncOptions => ({
    mode: 'core',
    cfg: CFG,
    git: fakeGit(),
    stateDir,
    lockWaitMs: 60,
    lockRetryMs: 10,
    timeoutMs: 500,
    ...over,
  });

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-headless-sync-'));
  });
  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  describe('배선 게이트', () => {
    it('원격 미설정(cfg=null)이면 null — 완전 무동작(락 파일도 안 만든다)', async () => {
      const git = fakeGit();
      expect(makeHeadlessWikiSync(base({ cfg: null, git }))).toBeNull();
      expect(git.calls).toEqual([]);
      // stateDir에 아무것도 쓰지 않았다(읽기전용 경로가 파일을 만드는 사고 방지).
      await expect(fs.readdir(stateDir)).resolves.toEqual([]);
    });

    it('브리지 모드(앱 상주)면 원격이 설정돼 있어도 null — 동기화는 앱이 담당(중복 실행 없음)', () => {
      const git = fakeGit();
      expect(makeHeadlessWikiSync(base({ mode: 'bridge', git }))).toBeNull();
      expect(git.calls).toEqual([]);
    });
  });

  describe('시작 동기화', () => {
    it('start()는 ensureRemote 후 pull→push를 1회 한다', async () => {
      const git = fakeGit();
      const sync = makeHeadlessWikiSync(base({ git }))!;
      const r = await sync.start();
      expect(r.ok).toBe(true);
      expect(git.calls).toEqual(['ensureRemote:file:///r.git', 'pull:main', 'push:main']);
    });

    it('주기 타이머를 걸지 않는다(수명이 들쭉날쭉한 헤드리스 — 간격이 지나도 추가 호출 없음)', async () => {
      const git = fakeGit();
      const sync = makeHeadlessWikiSync(base({ git, cfg: { ...CFG, syncIntervalSec: 0.02 } }))!;
      await sync.start();
      const after = [...git.calls];
      await new Promise((r) => setTimeout(r, 150)); // 간격(20ms)의 7배 대기
      expect(git.calls).toEqual(after);
    });

    it('락 파일은 끝나면 정리된다(다음 동기화가 막히지 않게)', async () => {
      const sync = makeHeadlessWikiSync(base())!;
      await sync.start();
      await expect(fs.readdir(stateDir)).resolves.toEqual([]);
    });
  });

  describe('쓰기 후 동기화', () => {
    it('wiki_write 성공 후 pull→push가 돈다', async () => {
      const git = fakeGit();
      const { deps, calls } = fakeDeps();
      const wrapped = makeHeadlessWikiSync(base({ git }))!.wrap(deps);
      const out = await wrapped.write!({ title: 't', content: 'c' });
      expect(calls).toEqual(['write:t']);
      expect(git.calls).toEqual(['pull:main', 'push:main']);
      expect(out).toContain('created t');
      expect(out).not.toContain('note:'); // 성공하면 잡음 없음
    });

    it('approve_proposal 성공 후 pull→push가 돈다', async () => {
      const git = fakeGit();
      const { deps } = fakeDeps();
      const wrapped = makeHeadlessWikiSync(base({ git }))!.wrap(deps);
      const out = await wrapped.proposals!.approve('id1');
      expect(out).toContain('approved proposal id1');
      expect(git.calls).toEqual(['pull:main', 'push:main']);
    });

    it('propose/reject는 동기화하지 않는다(제안은 state/proposals — 위키 git 저장소를 안 건드림)', async () => {
      const git = fakeGit();
      const { deps } = fakeDeps();
      const wrapped = makeHeadlessWikiSync(base({ git }))!.wrap(deps);
      await wrapped.propose({ title: 't', content: 'c' });
      await wrapped.proposals!.reject('id1');
      expect(git.calls).toEqual([]);
    });

    it('쓰기 결과 문자열 자체는 보존된다(래핑이 기존 응답을 갈아치우지 않음)', async () => {
      const { deps } = fakeDeps();
      const wrapped = makeHeadlessWikiSync(base())!.wrap(deps);
      expect(await wrapped.write!({ title: 't', content: 'c' })).toMatch(/^created t/);
    });
  });

  describe('실패 노출(조용한 실패 금지) — never-throw', () => {
    it('push가 거부되면 도구 응답 꼬리에 사유가 붙는다(예외는 안 던짐)', async () => {
      const git = fakeGit();
      git.push = async () => ({ ok: false, conflict: false });
      const { deps } = fakeDeps();
      const wrapped = makeHeadlessWikiSync(base({ git }))!.wrap(deps);
      const out = await wrapped.write!({ title: 't', content: 'c' });
      expect(out).toContain('created t');
      expect(out).toContain('push failed');
      expect(out).toContain('saved locally');
    });

    it('pull 충돌도 사유로 보고된다', async () => {
      const git = fakeGit();
      git.pull = async () => ({ ok: true, conflict: true });
      const { deps } = fakeDeps();
      const wrapped = makeHeadlessWikiSync(base({ git }))!.wrap(deps);
      expect(await wrapped.write!({ title: 't', content: 'c' })).toContain('conflict');
    });

    it('git이 예외를 던져도 도구 호출은 성공한다(동기화 실패가 저장을 죽이지 않는다)', async () => {
      const git = fakeGit();
      git.pull = async () => { throw new Error('auth denied'); };
      const { deps } = fakeDeps();
      const wrapped = makeHeadlessWikiSync(base({ git }))!.wrap(deps);
      const out = await wrapped.write!({ title: 't', content: 'c' });
      expect(out).toContain('created t');
      expect(out).toContain('auth denied');
    });

    it('git이 행(hang)이면 타임아웃 사유를 남기고 도구 응답을 돌려준다(호출을 인질로 잡지 않음)', async () => {
      const git = fakeGit();
      git.push = () => new Promise(() => { /* 영원히 무응답 */ });
      const { deps } = fakeDeps();
      const wrapped = makeHeadlessWikiSync(base({ git, timeoutMs: 40 }))!.wrap(deps);
      const out = await wrapped.write!({ title: 't', content: 'c' });
      expect(out).toContain('created t');
      expect(out).toContain('timed out');
    });

    it('start()가 실패해도 던지지 않는다', async () => {
      const git = fakeGit();
      git.ensureRemote = async () => { throw new Error('bad url'); };
      const sync = makeHeadlessWikiSync(base({ git }))!;
      const r = await sync.start();
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('bad url');
    });
  });

  describe('동시 쓰기 안전', () => {
    it('다른 프로세스가 락을 쥐고 있으면 git을 건드리지 않고 사유를 보고한다', async () => {
      const git = fakeGit();
      await fs.writeFile(path.join(stateDir, 'wiki-sync.lock'), '9999 held');
      const { deps } = fakeDeps();
      const wrapped = makeHeadlessWikiSync(base({ git }))!.wrap(deps);
      const out = await wrapped.write!({ title: 't', content: 'c' });
      expect(git.calls).toEqual([]); // 남의 git 작업과 인터리브하지 않음
      expect(out).toContain('another Engram process is syncing');
    });

    it('락이 풀리면 다음 쓰기는 정상 동기화된다', async () => {
      const git = fakeGit();
      const lock = path.join(stateDir, 'wiki-sync.lock');
      await fs.writeFile(lock, '9999 held');
      const { deps } = fakeDeps();
      const wrapped = makeHeadlessWikiSync(base({ git }))!.wrap(deps);
      await wrapped.write!({ title: 't', content: 'c' });
      await fs.rm(lock, { force: true });
      const out = await wrapped.write!({ title: 't2', content: 'c' });
      expect(git.calls).toEqual(['pull:main', 'push:main']);
      expect(out).not.toContain('another Engram process');
    });

    it('오래된(stale) 락은 탈취한다 — 크래시 잔여가 동기화를 영구히 막지 않게', async () => {
      const git = fakeGit();
      await fs.writeFile(path.join(stateDir, 'wiki-sync.lock'), 'dead pid');
      const { deps } = fakeDeps();
      const wrapped = makeHeadlessWikiSync(base({ git, lockStaleMs: 0 }))!.wrap(deps);
      await wrapped.write!({ title: 't', content: 'c' });
      expect(git.calls).toEqual(['pull:main', 'push:main']);
    });

    it('같은 프로세스의 동기화들은 큐로 직렬 실행된다(건너뛰지 않음 — push가 조용히 사라지면 안 됨)', async () => {
      const git = fakeGit();
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let first = true;
      git.pull = async (b: string) => {
        git.calls.push(`pull:${b}`);
        if (first) { first = false; await gate; }
        return { ok: true, conflict: false };
      };
      const { deps } = fakeDeps();
      const sync = makeHeadlessWikiSync(base({ git, timeoutMs: 2000 }))!;
      const wrapped = sync.wrap(deps);
      const a = wrapped.write!({ title: 'a', content: 'c' });
      const b = wrapped.write!({ title: 'b', content: 'c' });
      // 고정 20ms 대기는 부하가 걸린 전체 실행에서 첫 pull이 시작되기도 전에 지나가 0을 본다
      // (2026-07-30 실측 — v0.0.20 윈도우 CI를 세운 것과 같은 부류). 조건이 성립할 때까지 기다린다.
      const deadline = Date.now() + 5000;
      while (git.calls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 20)); // 두 번째가 끼어들 여유를 주고 나서 센다
      expect(git.calls.filter((c) => c.startsWith('pull')).length).toBe(1); // 두 번째는 대기 중
      release();
      await Promise.all([a, b]);
      expect(git.calls).toEqual(['pull:main', 'push:main', 'pull:main', 'push:main']);
    });
  });
});
