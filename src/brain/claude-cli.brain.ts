import { Injectable } from '@nestjs/common';
import spawn from 'cross-spawn';
import { BrainProvider, BrainResult } from './brain.port';
import { BrainProfile } from './brain.config';
import { Semaphore } from './semaphore';

// stream-json 이벤트에서 화면에 흘릴 텍스트 조각을 뽑는다.
// - assistant 메시지의 text 블록(메시지 단위 스트리밍)
// - --include-partial-messages 사용 시 stream_event의 text_delta(토큰 단위)
function extractDelta(ev: Record<string, unknown>): string {
  if (ev.type === 'assistant') {
    const content = (ev.message as { content?: Array<{ type?: string; text?: string }> })?.content;
    if (Array.isArray(content)) {
      return content.filter((c) => c?.type === 'text').map((c) => c.text ?? '').join('');
    }
  }
  if (ev.type === 'stream_event') {
    const event = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      return event.delta.text ?? '';
    }
  }
  return '';
}

// Claude CLI(claude -p) 어댑터(설계 §7.5). 구독 한도 내 토큰 $0.
// 모든 호출이 complete() 한 메서드로 수렴 → Semaphore가 유일한 choke point(설계 §8).
@Injectable()
export class ClaudeCliBrain implements BrainProvider {
  private readonly sem: Semaphore;

  constructor(private readonly profile: BrainProfile) {
    this.sem = new Semaphore(profile.concurrency);
  }

  complete(prompt: string, onChunk?: (text: string) => void): Promise<BrainResult> {
    return this.sem.run(() => this.spawnOnce(prompt, onChunk));
  }

  private spawnOnce(prompt: string, onChunk?: (text: string) => void): Promise<BrainResult> {
    return new Promise<BrainResult>((resolve) => {
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        ...(this.profile.model ? ['--model', this.profile.model] : []),
        ...this.profile.extraArgs,
      ];
      const child = spawn(this.profile.cli, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...this.profile.env },
      });

      let buf = '';
      let text = '';
      let costUsd = 0;
      let isError = false;
      let settled = false;

      const finish = (r: BrainResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolve(r);
      };

      const timer = setTimeout(
        () => finish({ text, costUsd, isError: true, raw: 'timeout' }),
        this.profile.timeoutMs,
      );

      child.stdout?.on('data', (d: Buffer) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line);
          } catch {
            continue; // 부분 줄/비JSON은 건너뜀
          }
          const delta = extractDelta(ev);
          if (delta) {
            text += delta;
            onChunk?.(delta);
          }
          if (ev.type === 'result') {
            costUsd = Number(ev.total_cost_usd ?? 0);
            isError = Boolean(ev.is_error);
            if (typeof ev.result === 'string') text = ev.result; // 최종 권위 텍스트로 교체
          }
        }
      });

      child.on('error', () => finish({ text: '', costUsd: 0, isError: true, raw: 'spawn-error' }));
      child.on('close', () => finish({ text, costUsd, isError }));
    });
  }
}
