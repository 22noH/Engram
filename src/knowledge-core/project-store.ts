import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface GateCommands { test: string; build: string; typecheck: string; }
export interface ProjectConfig {
  id: string;
  targetPath: string;
  branch: string;
  gate: GateCommands;
  acceptanceCriteria: string[];
  writePaths: string[];
  concurrency: number;
  budget: { tokens: number | null };
  approved: boolean;
}

// 프로젝트별 코딩 config 저장(설계 §5.2). config/projects/{id}.json — 타깃 repo 미오염.
@Injectable()
export class ProjectStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string { return path.join(this.dir, `${id}.json`); }

  async create(cfg: ProjectConfig): Promise<ProjectConfig> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(this.file(cfg.id), JSON.stringify(cfg, null, 2));
    return cfg;
  }

  async get(id: string): Promise<ProjectConfig | null> {
    try { return JSON.parse(await fs.promises.readFile(this.file(id), 'utf8')) as ProjectConfig; }
    catch { return null; }
  }

  async update(id: string, patch: Partial<ProjectConfig>): Promise<ProjectConfig> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`프로젝트 없음: ${id}`);
    const next = { ...cur, ...patch, id: cur.id };
    await fs.promises.writeFile(this.file(id), JSON.stringify(next, null, 2));
    return next;
  }

  async list(): Promise<ProjectConfig[]> {
    let files: string[];
    try { files = await fs.promises.readdir(this.dir); } catch { return []; }
    const out: ProjectConfig[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const c = await this.get(f.slice(0, -5));
      if (c) out.push(c);
    }
    return out;
  }

  async remove(id: string): Promise<void> {
    await fs.promises.rm(this.file(id), { force: true });
  }
}
