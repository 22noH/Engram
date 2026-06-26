import * as readline from 'readline';
import { Injectable } from '@nestjs/common';
import { Orchestrator } from '../agent-layer/orchestrator';
import { DEFAULT_USER } from '../pal/path-resolver';

// CLI 어댑터(설계 §9.1). 인수 파싱·프롬프트·stdout 쓰기 등 CLI 특유의 것을 여기 가둔다.
// 코어는 CoreMessage만 본다. 원샷·REPL 모두 같은 orchestrator.route()로 수렴.
@Injectable()
export class CliGateway {
  constructor(private readonly orchestrator: Orchestrator) {}

  async run(argv: string[]): Promise<void> {
    if (argv[0] === 'ask' && argv[1]) {
      await this.ask(argv.slice(1).join(' '));
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
}
