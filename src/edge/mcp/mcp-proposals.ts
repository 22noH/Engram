import { ProposalStore, Proposal } from '../../knowledge-core/proposal-store';
import { ProposalApplier } from '../proposal-applier';
import { DEFAULT_USER } from '../../pal/path-resolver';

// MCP list_proposals/approve_proposal/reject_proposal 공용 어댑터(§3.3) — 헤드리스 mcp-headless.ts와
// 앱 main.ts가 같은 모듈을 주입해 승인 대기열을 공유(설계 §3.3 "같은 원칙·같은 대기열").
// ws 경로(self.adapter.ts:361-385)와 같은 결의 in-flight 가드 — approving.has→throw / add / try{...}finally{delete}.
export interface McpProposalsDeps {
  list(): Promise<Array<{ id: string; title: string; op: string; targetSlug: string; preview: string }>>;
  approve(id: string): Promise<string>; // 성공 요약 텍스트(targetSlug 포함), 실패는 throw(도구층이 isError로)
  reject(id: string): Promise<string>;
}

const PREVIEW_LEN = 200;

export function makeMcpProposals(
  proposals: ProposalStore,
  applier: ProposalApplier,
  opts?: { approving?: Set<string>; onChanged?: () => void },
): McpProposalsDeps {
  const approving = opts?.approving ?? new Set<string>(); // 미전달=이 팩토리 호출 전용 자체 Set

  async function getPendingOrThrow(id: string): Promise<Proposal> {
    const p = await proposals.get(id);
    if (!p) throw new Error(`proposal not found: ${id}`);
    if (p.status !== 'pending') throw new Error(`proposal ${id} is not pending (status: ${p.status})`);
    return p;
  }

  return {
    async list() {
      const pending = await proposals.listPending(DEFAULT_USER);
      return pending.map((p) => ({
        id: p.id,
        title: p.title,
        op: p.op,
        targetSlug: p.targetSlug,
        preview: p.payload.slice(0, PREVIEW_LEN),
      }));
    },

    async approve(id: string) {
      if (approving.has(id)) throw new Error(`proposal ${id} is already being approved (in flight)`);
      approving.add(id); // 동기 마킹 — 다음 호출이 즉시 봄(TOCTOU 방지)
      try {
        const p = await getPendingOrThrow(id);
        await applier.apply(p);
        opts?.onChanged?.();
        return `approved proposal ${id}: ${p.targetSlug} (${p.op})`;
      } finally {
        approving.delete(id);
      }
    },

    async reject(id: string) {
      const p = await getPendingOrThrow(id);
      await applier.reject(p);
      opts?.onChanged?.();
      return `rejected proposal ${id}: ${p.targetSlug}`;
    },
  };
}
