import { Injectable } from '@nestjs/common';
import spawn from 'cross-spawn';
import { GateCommands } from '../knowledge-core/project-store';

export interface GateResult {
  pass: boolean;
  failed: 'typecheck' | 'build' | 'test' | null;
  output: string;
}

// 하드 바닥 게이트(설계 §8.1). Engram이 직접 실행 — 에이전트 자기보고 불신.
// 종료코드 0=통과. 순서: typecheck → build → test, 첫 빨강에서 멈춤.
@Injectable()
export class VerificationGate {
  async run(targetPath: string, gate: GateCommands): Promise<GateResult> {
    for (const stage of ['typecheck', 'build', 'test'] as const) {
      const cmd = gate[stage];
      if (!cmd || !cmd.trim()) continue; // 빈 명령은 스킵(해당 검사 없음)
      const { code, output } = await this.exec(cmd, targetPath);
      if (code !== 0) return { pass: false, failed: stage, output: `[${stage}] exit ${code}\n${output}` };
    }
    return { pass: true, failed: null, output: '' };
  }

  // ponytail: shell:true로 명령 문자열 그대로 실행 — 명령은 사람 승인된 config에서만 옴.
  private exec(cmd: string, cwd: string): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(cmd, [], { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('error', (e) => resolve({ code: 1, output: String(e) }));
      child.on('close', (code) => resolve({ code: code ?? 1, output: out.slice(-4000) }));
    });
  }
}
