import { Injectable } from '@nestjs/common';
import { PersonaRegistry } from './persona-registry';
import { PermissionFence } from './permission-fence';
import { BrainProvider } from '../brain/brain.port';
import { PinoLogger } from '../pal/logger';
import { CodingTicket } from '../knowledge-core/task-store';
import { ProjectConfig } from '../knowledge-core/project-store';
import { loadPrompt } from './prompt-store';
import { outputDirective } from './language';
import { brainErrorHint } from './brain-error-hints';
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

// 코딩 티켓 한 건의 두뇌 호출 타임아웃. 프로필 timeoutMs는 채팅 답변 기준(수 분)이라 에이전트
// 코딩(도구 돌리며 실제 편집)이 그 안에 못 끝나 2분 만에 죽던 실사용 발견(2026-08-01, 예약발 코딩).
// ponytail: 상수 고정 — 프로필이 이보다 길어도 이 값이 이긴다. 티켓당 30분을 넘기면 설정으로 뺄 것.
export const CODING_TIMEOUT_MS = 1_800_000;

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
      timeoutMs: CODING_TIMEOUT_MS,
      cwd: project.targetPath,
      extraArgs: flags, // CLI 두뇌용(무변경)
      codeGuard: (p) => this.fence.assertCodingWrite(p, project.writePaths, permMode), // API 두뇌용(Phase 8b-1)
      // 셸 켜짐(off 아님)일 때만 주입 → off면 Bash 도구 미노출. plan·files는 여기서 걸러져 명령 도구가
      // 아예 안 붙고, auto/allowlist(restricted)는 assertCommandAllowed가 판정한다.
      ...(this.fence.shellEnabled(permMode) ? { cmdGuard: (cmd: string) => this.fence.assertCommandAllowed(cmd, permMode) } : {}),
    });
    // 실패 사유를 버리지 않는다(실사용 발견 2026-07-25): 예전엔 이 자리에서 "호출 실패"만 던져
    // r.raw(CLI가 실제로 뱉은 사유 — 미로그인·사용량 한도·인수 오류 등)가 통째로 사라졌다.
    // 그 결과 티켓이 실패해도 로그·화면 어디에도 왜인지가 없어 진단이 불가능했다.
    // 채팅 경로가 이미 쓰는 brainErrorHint와 같은 결로, 사유가 있으면 붙여서 올린다.
    if (r.isError) {
      // raw가 없을 때만 기존 문구 그대로(회귀 0) — brainErrorHint는 빈 입력에도 일반 문구를 돌려주므로
      // 그대로 붙이면 사유가 없는데 있는 것처럼 보인다.
      const why = r.raw == null || r.raw === '' ? '' : brainErrorHint(r.raw);
      throw new Error(`코딩 두뇌 호출 실패: ${personaName}/${ticket.id}${why ? ` — ${why}` : ''}`);
    }
    return r.text;
  }
}
