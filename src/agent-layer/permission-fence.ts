import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import { Persona } from './persona-registry';

export interface FenceConfig {
  default: 'deny';
  allow: { tools: Record<string, string[]>; writePaths: string[]; denyPaths: string[] };
}

const EMPTY = (): FenceConfig => ({ default: 'deny', allow: { tools: {}, writePaths: [], denyPaths: [] } });

// 도구 권한 울타리(설계 §8). 새 권한엔진 ❌ — 네이티브 권한 플래그를 산출만. default-deny.
@Injectable()
export class PermissionFence {
  private cfg: FenceConfig = EMPTY();
  constructor(private readonly configPath: string) {}

  async load(): Promise<void> {
    try {
      this.cfg = JSON.parse(await fs.promises.readFile(this.configPath, 'utf8')) as FenceConfig;
    } catch {
      this.cfg = EMPTY(); // 없음/깨짐 → 전부 거부(안전 기본)
    }
  }

  // Claude Code 하네스 위에서 도는 두뇌만 도구 가능(진짜 Claude + 로컬LLM 백엔드).
  isHarnessBrain(brain: string): boolean {
    return !brain.startsWith('gemini') && !brain.startsWith('codex'); // ponytail: 이름 규칙 — 정밀화는 brains.json 조회로
  }

  allowedTools(persona: Persona): string[] {
    if (!this.isHarnessBrain(persona.brain)) return [];
    const granted = this.cfg.allow.tools[persona.name] ?? [];
    return persona.tools.filter((t) => granted.includes(t));
  }

  // spawn args 조각: --allowedTools + 쓰기 허용 폴더(--add-dir). denyPaths는 절대 미포함.
  spawnFlags(persona: Persona): string[] {
    const tools = this.allowedTools(persona);
    if (tools.length === 0) return [];
    const flags = ['--allowedTools', tools.join(',')];
    const writes = this.cfg.allow.writePaths.filter((p) => !this.cfg.allow.denyPaths.includes(p));
    for (const w of writes) flags.push('--add-dir', w);
    return flags;
  }
}
