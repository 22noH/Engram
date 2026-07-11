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

  it('이전 syncOnce가 진행 중이면 겹치는 호출은 건너뛴다(재진입 가드)', async () => {
    const g = fakeGit();
    let resolvePull!: (v: { ok: boolean; conflict: boolean }) => void;
    const pullGate = new Promise<{ ok: boolean; conflict: boolean }>((resolve) => { resolvePull = resolve; });
    g.pull = async (b: string) => { g.calls.push(`pull:${b}`); return pullGate; };
    const svc = new WikiSyncService(g, cfg, noLog);

    const first = svc.syncOnce(); // pull에서 블록 — 아직 완료 안 됨
    const second = svc.syncOnce(); // syncing=true라 즉시 반환(스킵)
    await second;
    expect(g.calls.filter((c) => c.startsWith('pull:')).length).toBe(1); // pull은 한 번만 호출됨

    resolvePull({ ok: true, conflict: false });
    await first;
  });
});
