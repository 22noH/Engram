import * as readline from 'readline';
import { Injectable } from '@nestjs/common';
import { Orchestrator } from '../agent-layer/orchestrator';
import { DEFAULT_USER } from '../pal/path-resolver';
import { ProposalStore } from '../knowledge-core/proposal-store';
import { ProposalApplier } from './proposal-applier';

// CLI 어댑터(설계 §9.1). 인수 파싱·프롬프트·stdout 쓰기 등 CLI 특유의 것을 여기 가둔다.
// 코어는 CoreMessage만 본다. 원샷·REPL 모두 같은 orchestrator.route()로 수렴.
@Injectable()
export class CliGateway {
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly proposals: ProposalStore,
    private readonly applier: ProposalApplier,
  ) {}

  async run(argv: string[]): Promise<void> {
    if (argv[0] === 'ask' && argv[1]) {
      await this.ask(argv.slice(1).join(' '));
    } else if (argv[0] === 'digest') {
      const s = await this.orchestrator.digest(DEFAULT_USER);
      process.stdout.write(`다이제스트 완료: 추출 ${s.extracted} · 통과 ${s.gated} · 제안 ${s.proposed}건\n`);
    } else if (argv[0] === 'review') {
      await this.review();
    } else if (argv.length === 0) {
      await this.repl();
    } else {
      process.stdout.write('사용법: engram ask "질문"  |  engram (REPL)\n');
    }
  }

  private async ask(question: string): Promise<void> {
    await this.orchestrator.route(
      { text: question, userId: DEFAULT_USER },
      (t) => process.stdout.write(t),
    );
    process.stdout.write('\n');
  }

  private async repl(): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write('Engram REPL — 질문을 입력하세요 (exit 종료)\n> ');
    for await (const line of rl) {
      const q = line.trim();
      if (q === 'exit' || q === 'quit') break;
      if (q) {
        await this.orchestrator.route({ text: q, userId: DEFAULT_USER }, (t) => process.stdout.write(t));
        process.stdout.write('\n');
      }
      process.stdout.write('> ');
    }
    rl.close();
  }

  // 승인 게이트(설계 §6 ⑤). pending 제안을 순서대로 보여주고 사람이 a/r/s로 판정.
  // 인터랙티브 readline 루프 — 단위테스트 불가(Task 11 통합 스모크로 커버).
  private async review(): Promise<void> {
    const pending = await this.proposals.listPending(DEFAULT_USER);
    if (pending.length === 0) { process.stdout.write('대기 중인 제안이 없습니다.\n'); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));
    for (const p of pending) {
      process.stdout.write(
        `\n[${p.op}] ${p.targetSlug} (중요도 ${p.importance}, 신뢰 ${p.verdict.confidence})\n` +
        `  내용: ${p.payload}\n  출처: ${p.sources.join(', ')}\n  판정: ${p.verdict.reason}\n`,
      );
      const a = (await ask('  [a]승인 / [r]거부 / [s]건너뜀 > ')).trim().toLowerCase();
      if (a === 'a') { await this.applier.apply(p); process.stdout.write('  → 반영됨\n'); }
      else if (a === 'r') { await this.applier.reject(p); process.stdout.write('  → 거부됨\n'); }
      else process.stdout.write('  → 건너뜀\n');
    }
    rl.close();
  }
}
