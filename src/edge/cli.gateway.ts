import * as readline from 'readline';
import { Injectable, Optional } from '@nestjs/common';
import { Orchestrator } from '../agent-layer/orchestrator';
import { DEFAULT_USER, PathResolver } from '../pal/path-resolver';
import { ProposalStore } from '../knowledge-core/proposal-store';
import { ProposalApplier } from './proposal-applier';
import { MeetingEngine } from '../agent-layer/meeting-engine';
import { loadMeetings, saveMeetings } from './meeting-config';

// CLI 어댑터(설계 §9.1). 인수 파싱·프롬프트·stdout 쓰기 등 CLI 특유의 것을 여기 가둔다.
// 코어는 CoreMessage만 본다. 원샷·REPL 모두 같은 orchestrator.route()로 수렴.
@Injectable()
export class CliGateway {
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly proposals: ProposalStore,
    private readonly applier: ProposalApplier,
    @Optional() private readonly paths?: PathResolver,
    @Optional() private readonly meetingEngine?: MeetingEngine,
  ) {}

  async run(argv: string[]): Promise<void> {
    if (argv[0] === 'ask' && argv[1]) {
      await this.ask(argv.slice(1).join(' '));
    } else if (argv[0] === 'digest') {
      const s = await this.orchestrator.digest(DEFAULT_USER);
      process.stdout.write(`다이제스트 완료: 추출 ${s.extracted} · 통과 ${s.gated} · 제안 ${s.proposed}건\n`);
    } else if (argv[0] === 'review') {
      await this.review();
    } else if (argv[0] === 'team' && argv[1]) {
      const names = argv[1].split(',').map((s) => s.trim()).filter(Boolean);
      const q = argv.slice(2).join(' ');
      const out = await this.orchestrator.collaborate(q, names, DEFAULT_USER);
      process.stdout.write(out + '\n');
    } else if (argv[0] === 'meeting') {
      await this.meeting(argv.slice(1));
    } else if (argv.length === 0) {
      await this.repl();
    } else {
      process.stdout.write('사용법: engram ask "질문" | engram digest | engram review | engram team <names> <q> | engram meeting add|list|remove|run | engram (REPL)\n');
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

  private async meeting(args: string[]): Promise<void> {
    if (!this.paths) throw new Error('PathResolver가 주입되지 않았습니다. EdgeModule에 PathResolver를 등록하세요.');
    const dir = this.paths.getConfigDir();
    const defs = loadMeetings(dir);
    if (args[0] === 'list') {
      process.stdout.write(defs.map((d) => `${d.name}  [${d.schedule}]  ${d.roster.join(',')}`).join('\n') + '\n');
    } else if (args[0] === 'add') {
      // engram meeting add <name> <cron> <roster,comma> <agenda...>
      defs.push({ name: args[1], schedule: args[2], roster: args[3].split(','), agenda: args.slice(4).join(' ') });
      saveMeetings(dir, defs);
      process.stdout.write(`회의 추가: ${args[1]}\n`);
    } else if (args[0] === 'remove') {
      saveMeetings(dir, defs.filter((d) => d.name !== args[1]));
      process.stdout.write(`회의 삭제: ${args[1]}\n`);
    } else if (args[0] === 'run') {
      if (!this.meetingEngine) throw new Error('MeetingEngine이 주입되지 않았습니다. EdgeModule에 MeetingEngine을 등록하세요.');
      const def = defs.find((d) => d.name === args[1]);
      if (!def) { process.stdout.write(`회의 없음: ${args[1]}\n`); return; }
      const r = await this.meetingEngine.run(def, DEFAULT_USER);
      process.stdout.write(`회의록: ${r.minutesSlug}\n`);
    } else {
      process.stdout.write('사용법: engram meeting add|list|remove|run\n');
    }
  }

  // 승인 게이트(설계 §6 ⑤). pending 제안을 순서대로 보여주고 사람이 a/r/s로 판정.
  // 인터랙티브 readline 루프 — 단위테스트 불가(Task 11 통합 스모크로 커버).
  private async review(): Promise<void> {
    const pending = await this.proposals.listPending(DEFAULT_USER);
    if (pending.length === 0) { process.stdout.write('대기 중인 제안이 없습니다.\n'); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let closed = false;
    rl.on('close', () => { closed = true; });
    // stdin EOF(파이프 끝·Ctrl-D)에 견고하게: 닫힌 rl에 question을 호출하면 ERR_USE_AFTER_CLOSE로 크래시한다.
    // 이미 닫혔으면 즉시 빈 입력(=건너뜀), 질문 도중 닫히면 close를 레이스로 받아 안전하게 resolve한다.
    const ask = (q: string): Promise<string> =>
      new Promise((res) => {
        if (closed) return res('');
        const onClose = (): void => res('');
        rl.once('close', onClose);
        rl.question(q, (ans) => { rl.removeListener('close', onClose); res(ans); });
      });
    for (const p of pending) {
      if (closed) { process.stdout.write('\n입력이 종료되어 남은 제안은 다음 review에서 처리합니다.\n'); break; }
      process.stdout.write(
        `\n[${p.op}] ${p.targetSlug} (중요도 ${p.importance}, 신뢰 ${p.verdict.confidence})\n` +
        `  내용: ${p.payload}\n  출처: ${p.sources.join(', ')}\n  판정: ${p.verdict.reason}\n`,
      );
      const a = (await ask('  [a]승인 / [r]거부 / [s]건너뜀 > ')).trim().toLowerCase();
      if (a === 'a') {
        try { await this.applier.apply(p); process.stdout.write('  → 반영됨\n'); }
        catch (e) { process.stdout.write(`  → 반영 실패(건너뜀): ${String(e)}\n`); } // slug 충돌 등으로 세션 전체가 죽지 않게
      } else if (a === 'r') { await this.applier.reject(p); process.stdout.write('  → 거부됨\n'); }
      else process.stdout.write('  → 건너뜀\n');
    }
    rl.close();
  }
}
