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
