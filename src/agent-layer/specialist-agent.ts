import { Injectable } from '@nestjs/common';
import { PersonaRegistry } from './persona-registry';
import { PermissionFence } from './permission-fence';
import { BrainProvider } from '../brain/brain.port';
import { RagStore } from '../knowledge-core/rag/rag-store';
import { PinoLogger } from '../pal/logger';

// 제네릭 협업 워커(설계 §7.3). persona+brain만 주입, 코드는 하나. stateless — 매 호출 독립.
@Injectable()
export class SpecialistAgent {
  constructor(
    private readonly registry: PersonaRegistry,
    private readonly fence: PermissionFence,
    private readonly resolveBrain: (brainKey: string) => BrainProvider,
    private readonly rag: RagStore,
    private readonly logger: PinoLogger,
  ) {}

  async contribute(personaName: string, question: string, userId: string): Promise<string> {
    const persona = this.registry.get(personaName);
    if (!persona) throw new Error(`알 수 없는 페르소나: ${personaName}`);
    const hits = await this.rag.search(question, 5, userId);
    const ctx = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.text}`).join('\n\n');
    const prompt = [
      persona.prompt,
      `\n# 공유 위키(근거)\n${ctx || '(없음)'}`,
      `\n# 다룰 질문\n${question}`,
      '\n네 역할 관점에서만 기여하라. 다른 전문가와 대화하지 말고 네 분석만 적어라.',
    ].join('\n');
    const brain = this.resolveBrain(persona.brain);
    const r = await brain.complete(prompt);
    if (r.isError) throw new Error(`두뇌 호출 실패: ${personaName}`);
    return r.text;
  }
}
