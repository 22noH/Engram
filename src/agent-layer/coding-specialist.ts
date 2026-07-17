import { Injectable } from '@nestjs/common';
import { PersonaRegistry } from './persona-registry';
import { PermissionFence } from './permission-fence';
import { BrainProvider } from '../brain/brain.port';
import { PinoLogger } from '../pal/logger';
import { CodingTicket } from '../knowledge-core/task-store';
import { ProjectConfig } from '../knowledge-core/project-store';
import { loadPrompt } from './prompt-store';
import { outputDirective } from './language';

// prompts/coding-rules.md 없을 때의 내장 기본값(out-of-box 동작 보장).
export const CODING_RULES_DEFAULT = [
  'Rules:',
  '- Edit the code in the target directory directly. Do only the piece you were given.',
  '- Do not run tests or builds — Engram runs the verification gate itself.',
  '- Do not discuss file existence, git state, CI, or process at length. Just change the code.',
  '- Do not talk to other agents/pieces.',
  '- Report in one or two concise lines.',
].join('\n');

// 제네릭 코딩 워커(설계 §3, §9). stateless. 코드 변경은 도구 부수효과(타깃 cwd).
// 게이트는 호출자가 별도로 돌린다(에이전트 자기보고 불신, §8.1).
@Injectable()
export class CodingSpecialist {
  constructor(
    private readonly registry: PersonaRegistry,
    private readonly fence: PermissionFence,
    private readonly resolveBrain: (brainKey: string) => BrainProvider,
    private readonly logger: PinoLogger,
  ) {}

  async work(personaName: string, ticket: CodingTicket, project: ProjectConfig, onChunk?: (t: string) => void): Promise<string> {
    const persona = this.registry.get(personaName);
    if (!persona) throw new Error(`알 수 없는 페르소나: ${personaName}`);
    const failNote = ticket.gate && !ticket.gate.pass ? `\n# Previous gate failure (fix it)\n${ticket.gate.output}` : '';
    const prompt = [
      persona.prompt,
      `\n# Work area\n${ticket.area}`,
      `\n# Task\n${ticket.instruction}`,
      failNote,
      `\n${loadPrompt('coding-rules', CODING_RULES_DEFAULT)}`,
      outputDirective('interactive'),
    ].join('\n');
    // 자동모드: 표준 코딩 toolset + 백스톱 밖 타깃 스코프 + acceptEdits(울타리 안 자율 편집).
    const flags = [...this.fence.codingAutoFlags(project.writePaths), '--permission-mode', 'acceptEdits'];
    const brain = this.resolveBrain(persona.brain);
    const r = await brain.complete(prompt, onChunk, {
      cwd: project.targetPath,
      extraArgs: flags, // CLI 두뇌용(무변경)
      codeGuard: (p) => this.fence.assertCodingWrite(p, project.writePaths), // API 두뇌용(Phase 8b-1)
      // 셸 켜짐(off 아님)일 때만 주입 → off면 Bash 도구 미노출. auto/allowlist는 assertCommandAllowed가 판정.
      ...(this.fence.shellEnabled() ? { cmdGuard: (cmd: string) => this.fence.assertCommandAllowed(cmd) } : {}),
    });
    if (r.isError) throw new Error(`코딩 두뇌 호출 실패: ${personaName}/${ticket.id}`);
    return r.text;
  }
}
