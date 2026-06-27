import { Injectable } from '@nestjs/common';
import { PersonaRegistry } from './persona-registry';
import { PermissionFence } from './permission-fence';
import { BrainProvider } from '../brain/brain.port';
import { PinoLogger } from '../pal/logger';
import { CodingTicket } from '../knowledge-core/task-store';
import { ProjectConfig } from '../knowledge-core/project-store';

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
    const failNote = ticket.gate && !ticket.gate.pass ? `\n# 직전 게이트 실패(고쳐라)\n${ticket.gate.output}` : '';
    const prompt = [
      persona.prompt,
      `\n# 작업 영역\n${ticket.area}`,
      `\n# 할 일\n${ticket.instruction}`,
      failNote,
      '\n타깃 작업 디렉터리에서 코드를 직접 수정하라. 다른 에이전트와 대화하지 말고 네 조각만 끝내라.',
    ].join('\n');
    // 자동모드: 표준 코딩 toolset + 백스톱 밖 타깃 스코프 + acceptEdits(울타리 안 자율 편집).
    const flags = [...this.fence.codingAutoFlags(project.writePaths), '--permission-mode', 'acceptEdits'];
    const brain = this.resolveBrain(persona.brain);
    const r = await brain.complete(prompt, onChunk, { cwd: project.targetPath, extraArgs: flags });
    if (r.isError) throw new Error(`코딩 두뇌 호출 실패: ${personaName}/${ticket.id}`);
    return r.text;
  }
}
