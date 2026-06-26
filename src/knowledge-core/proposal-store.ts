import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PathResolver } from '../pal/path-resolver';

export type ProposalOp = 'create' | 'append' | 'supersede';
export interface ProposalVerdict { confidence: number; reason: string; conflictSlugs?: string[] }
export interface Proposal {
  id: string; userId: string; createdTs: string;
  op: ProposalOp; targetSlug: string; title: string; category: string;
  payload: string; sources: string[]; importance: number;
  verdict: ProposalVerdict; status: 'pending' | 'approved' | 'rejected';
}
export type NewProposal = Omit<Proposal, 'id' | 'createdTs' | 'status'>;

@Injectable()
export class ProposalStore {
  constructor(private readonly paths: PathResolver) {}
  private dir(): string { return path.join(this.paths.getDataDir(), 'state', 'proposals'); }
  private file(id: string): string { return path.join(this.dir(), `${id}.json`); }

  async enqueue(p: NewProposal): Promise<Proposal> {
    const createdTs = new Date().toISOString();
    const rand = Math.floor(Math.random() * 1e6).toString(36); // 런타임 — Math.random 허용
    const id = `${createdTs.replace(/[:.]/g, '-')}-${p.targetSlug}-${rand}`;
    const full: Proposal = { ...p, id, createdTs, status: 'pending' };
    await fs.mkdir(this.dir(), { recursive: true });
    await fs.writeFile(this.file(id), JSON.stringify(full, null, 2));
    return full;
  }
  async get(id: string): Promise<Proposal | null> {
    try { return JSON.parse(await fs.readFile(this.file(id), 'utf8')) as Proposal; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  async listPending(userId?: string): Promise<Proposal[]> {
    let files: string[];
    try { files = (await fs.readdir(this.dir())).filter((f) => f.endsWith('.json')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const out: Proposal[] = [];
    for (const f of files) {
      const p = JSON.parse(await fs.readFile(path.join(this.dir(), f), 'utf8')) as Proposal;
      if (p.status === 'pending' && (!userId || p.userId === userId)) out.push(p);
    }
    return out.sort((a, b) => a.createdTs.localeCompare(b.createdTs));
  }
  private async setStatus(id: string, status: Proposal['status']): Promise<void> {
    const p = await this.get(id);
    if (!p) throw new Error(`Proposal not found: ${id}`);
    p.status = status;
    await fs.writeFile(this.file(id), JSON.stringify(p, null, 2));
  }
  markApproved(id: string): Promise<void> { return this.setStatus(id, 'approved'); }
  markRejected(id: string): Promise<void> { return this.setStatus(id, 'rejected'); }
}
