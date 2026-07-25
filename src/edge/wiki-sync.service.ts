import type { WikiRemoteConfig } from '../knowledge-core/wiki/wiki-remote.config';

// WikiGit 원격 표면(구조적 타입 — 순환 회피).
interface WikiSyncer {
  ensureRemote(url: string): Promise<void>;
  pull(branch: string): Promise<{ ok: boolean; conflict: boolean }>;
  push(branch: string): Promise<{ ok: boolean; conflict: boolean }>;
}

// 한 번의 동기화 결과. ok=false면 reason에 사람이 읽을 사유(인증/네트워크/충돌/중복실행).
// 상주(main.ts)는 이 값을 무시하고 로그만 보지만, 헤드리스 MCP는 도구 응답에 사유를 실어
// "조용한 실패"를 없앤다(headless-wiki-sync.ts). — 반환값 추가일 뿐 동작은 무변경.
export interface WikiSyncOutcome {
  ok: boolean;
  reason?: string;
}

// 위키 git 원격 동기화(Phase 15b, plain — main.ts 배선). 주기적으로 pull→push.
// 예외/충돌은 로그만(상주 불사). pull로 들어온 .md는 WikiWatcher가 재색인(자동).
export class WikiSyncService {
  private timer?: ReturnType<typeof setInterval>;
  private syncing = false;

  constructor(
    private readonly git: WikiSyncer,
    private readonly cfg: WikiRemoteConfig,
    private readonly logger: { warn(msg: string, ctx?: string): void },
  ) {}

  // periodic:false면 주기 타이머를 걸지 않는다(최초 ensureRemote+1회 동기화만) — 헤드리스 MCP처럼
  // 상주가 아닌 프로세스용. 기본값은 기존 그대로 주기 가동(앱/서버 경로 무변경).
  async start(opts: { periodic?: boolean } = {}): Promise<WikiSyncOutcome> {
    let remoteErr: string | null = null;
    try {
      await this.git.ensureRemote(this.cfg.remote);
    } catch (e) {
      // 기존과 동일하게 "경고만 하고 계속" — 원격 설정이 실패해도 주기 동기화는 걸어둔다(다음 tick 회복).
      this.logger.warn(`위키 원격 설정 실패: ${String(e)}`, 'WikiSync');
      remoteErr = `remote setup failed: ${String(e)}`;
    }
    const first = await this.syncOnce();
    if (opts.periodic !== false) {
      this.timer = setInterval(() => { void this.syncOnce(); }, this.cfg.syncIntervalSec * 1000);
    }
    if (remoteErr) return { ok: false, reason: remoteErr };
    return first;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // never-throw. 반환값은 "왜 실패했는지"를 알아야 하는 호출자(헤드리스 MCP)만 쓴다 — 로그·경고는
  // 기존 그대로라 주기 동기화(앱)의 동작·로그량은 무변경(오프라인 tick이 매번 경고를 뿜지 않는다).
  async syncOnce(): Promise<WikiSyncOutcome> {
    if (this.syncing) return { ok: false, reason: 'another sync is already in progress' }; // 겹침 방지(이번 tick 건너뜀)
    this.syncing = true;
    const problems: string[] = [];
    try {
      const pl = await this.git.pull(this.cfg.branch);
      if (pl.conflict) {
        this.logger.warn('위키 pull 병합 충돌 — 로컬 유지(수동/15c 해결 필요)', 'WikiSync');
        problems.push('pull merge conflict — local kept');
      } else if (!pl.ok) {
        problems.push('pull failed (remote unreachable or credentials denied)');
      }
      const ps = await this.git.push(this.cfg.branch);
      if (ps.conflict) {
        this.logger.warn('위키 push 충돌 — 다음 주기 재시도', 'WikiSync');
        problems.push('push conflict — will retry');
      } else if (!ps.ok) {
        problems.push('push failed (remote unreachable or credentials denied)');
      }
    } catch (e) {
      this.logger.warn(`위키 동기화 오류: ${String(e)}`, 'WikiSync');
      return { ok: false, reason: `sync error: ${String(e)}` };
    } finally {
      this.syncing = false;
    }
    return problems.length > 0 ? { ok: false, reason: problems.join('; ') } : { ok: true };
  }
}
