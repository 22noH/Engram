import { Injectable } from '@nestjs/common';
import { PersonaRegistry } from './persona-registry';
import { PermissionFence } from './permission-fence';
import { BrainProvider } from '../brain/brain.port';
import { PinoLogger } from '../pal/logger';
import { CodingTicket } from '../knowledge-core/task-store';
import { ProjectConfig } from '../knowledge-core/project-store';
import { loadPrompt } from './prompt-store';
import { outputDirective } from './language';
import type { PermMode } from '../../shared/protocol';

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

  // brainOverride: 채널 두뇌(스펙 §3.2, Task 2) — 지정되면 persona.brain 조회보다 우선한다. 미지정=기존 동작(회귀 0).
  // permMode: 이 턴의 채널 권한 모드(코드 채널별). 부팅 시 캐시한 전역 설정이 아니라 이 인자가 게이트
  //   판정을 지배한다 — 호출자(Orchestrator)가 턴마다 정해 넘긴다. 미지정=전역 설정 폴백(회귀 0).
  async work(
    personaName: string,
    ticket: CodingTicket,
    project: ProjectConfig,
    onChunk?: (t: string) => void,
    brainOverride?: BrainProvider,
    permMode?: PermMode,
  ): Promise<string> {
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
    // 계획만(plan)이면 읽기 전용 toolset이고 acceptEdits도 안 붙인다(승인할 편집 자체가 없다).
    const flags = [
      ...this.fence.codingAutoFlags(project.writePaths, permMode),
      ...(permMode === 'plan' ? [] : ['--permission-mode', 'acceptEdits']),
    ];
    const brain = brainOverride ?? this.resolveBrain(persona.brain);
    const r = await brain.complete(prompt, onChunk, {
      cwd: project.targetPath,
      extraArgs: flags, // CLI 두뇌용(무변경)
      codeGuard: (p) => this.fence.assertCodingWrite(p, project.writePaths, permMode), // API 두뇌용(Phase 8b-1)
      // 셸 켜짐(off 아님)일 때만 주입 → off면 Bash 도구 미노출. plan·files는 여기서 걸러져 명령 도구가
      // 아예 안 붙고, auto/allowlist(restricted)는 assertCommandAllowed가 판정한다.
      ...(this.fence.shellEnabled(permMode) ? { cmdGuard: (cmd: string) => this.fence.assertCommandAllowed(cmd, permMode) } : {}),
    });
    if (r.isError) throw new Error(`코딩 두뇌 호출 실패: ${personaName}/${ticket.id}`);
    return r.text;
  }
}
