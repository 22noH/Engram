import { Injectable } from '@nestjs/common';
import spawn from 'cross-spawn';
import { BrainProvider, BrainResult, CompleteOpts } from './brain.port';
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

  complete(prompt: string, onChunk?: (text: string) => void, opts?: CompleteOpts): Promise<BrainResult> {
    return this.sem.run(() => this.spawnOnce(prompt, onChunk, opts));
  }

  private spawnOnce(prompt: string, onChunk?: (text: string) => void, opts?: CompleteOpts): Promise<BrainResult> {
    return new Promise<BrainResult>((resolve) => {
      // 헤드리스 claude -p는 미지정 도구를 거부한다. 프로필/호출이 --allowedTools를 안 주면
      // 웹검색·웹fetch(읽기전용, 안전)를 기본 허용 — 어떤 프로필(judge 등)이 빠뜨려도 막히지 않게.
      // 프로필이 직접 --allowedTools를 지정하면 사용자 의도 우선(중복 안 붙임).
      const extra = [...this.profile.extraArgs, ...(opts?.extraArgs ?? [])];
      const hasAllowed = extra.includes('--allowedTools');
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        ...(this.profile.model ? ['--model', this.profile.model] : []),
        ...(hasAllowed ? [] : ['--allowedTools', 'WebSearch,WebFetch']),
        ...extra,
      ];
      const child = spawn(this.profile.cli, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...this.profile.env },
        cwd: opts?.cwd,
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
        opts?.timeoutMs ?? this.profile.timeoutMs,
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
