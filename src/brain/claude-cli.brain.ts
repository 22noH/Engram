import { Injectable } from '@nestjs/common';
import spawn from 'cross-spawn';
import { BrainProvider, BrainResult, CompleteOpts } from './brain.port';
import { BrainProfile } from './brain.config';
import { Semaphore } from './semaphore';
import { readClaudeMcpServers } from './claude-mcp-import';
import { killTree } from './shell-tool';

// 고정 기본 4개(엔그램 자체 MCP·웹 도구) — 판독 실패 시 폴백값이자 항상 포함되는 하한선.
const BASE_ALLOWED_TOOLS = ['WebSearch', 'WebFetch', 'mcp__engram', 'mcp__plugin_engram_engram'];

// 클로드의 등록된 MCP 서버 전체를 --allowedTools로 동적 구성(설계 §3.4). 스폰마다 재판독
// (listBrainNames와 같은 요청시점 재조회 관성 — 설치 후 재시작 없이 반영). 판독 실패는
// 어떤 사유든(깨진 JSON·권한 등) 현행 고정 기본 4개로 폴백 — 헤드리스 claude -p가 막히면 안 됨.
function buildAllowedTools(): string {
  try {
    const entries = readClaudeMcpServers();
    const extra: string[] = [];
    for (const e of entries) {
      extra.push(`mcp__${e.name}`);
      if (e.pluginName) extra.push(`mcp__plugin_${e.pluginName}_${e.name}`);
    }
    return Array.from(new Set([...BASE_ALLOWED_TOOLS, ...extra])).join(',');
  } catch {
    return BASE_ALLOWED_TOOLS.join(',');
  }
}

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

// 두뇌 활동 표시(Task 1): assistant 메시지 content 블록 중 tool_use(Anthropic Messages API와 동일
// 블록 shape — Claude Code의 stream-json이 그대로 실어보낸다)의 이름만 등장 순서대로 뽑는다.
// stream_event(부분 메시지) 쪽은 tool_use 블록이 완결된 형태로만 오지 않아(input_json_delta 등
// 조각남) 다루지 않는다 — assistant 메시지 단위 이벤트만으로 충분(텍스트 델타와 달리 도구 이름은
// 스트리밍 중간에 필요하지 않다).
function extractToolUseNames(ev: Record<string, unknown>): string[] {
  if (ev.type !== 'assistant') return [];
  const content = (ev.message as { content?: Array<{ type?: string; name?: unknown }> })?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c?.type === 'tool_use' && typeof c.name === 'string').map((c) => c.name as string);
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
      // 웹검색·웹fetch(읽기전용, 안전)+엔그램 자체 MCP(고정 4개, buildAllowedTools의 하한선)에 더해
      // 클로드에 등록된 MCP 서버 전체(claude-mcp-import 판독, 설계 §3.4)를 기본 허용 — CLI 하네스가
      // 지휘자로서 ask_brain(다른 모델 호출)·위키 도구·사용자가 클로드에 붙여둔 MCP를 두루 쓸 수 있게.
      // 프로필이 직접 --allowedTools를 지정하면 사용자 의도 우선(중복 안 붙임).
      const extra = [...this.profile.extraArgs, ...(opts?.extraArgs ?? [])];
      const hasAllowed = extra.includes('--allowedTools');
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        ...(this.profile.model ? ['--model', this.profile.model] : []),
        ...(hasAllowed ? [] : ['--allowedTools', buildAllowedTools()]),
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
      let toolSeq = 0; // 두뇌 활동 표시(Task 1): 이 spawn 전체에 걸친 1부터 시작하는 도구 실행 순번.

      const finish = (r: BrainResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onAbort);
        // Task 4(여러 줄 입력+생성 중지): shell-tool의 killTree 재사용 — Win은 taskkill /T /F로 자식
        // 트리째 종료(child.kill() 단독은 cross-spawn이 .cmd 실행을 위해 끼워 넣는 cmd.exe 래퍼 아래
        // 손자 프로세스를 못 잡을 수 있음). pid 미확보(spawn 실패 등)면 기존 child.kill()로 폴백.
        if (child.pid) killTree(child.pid); else child.kill();
        resolve(r);
      };

      const timer = setTimeout(
        () => finish({ text, costUsd, isError: true, raw: 'timeout' }),
        opts?.timeoutMs ?? this.profile.timeoutMs,
      );
      // Task 4: 외부 signal(stopGeneration) → 즉시 종료(부분 텍스트는 버리고 aborted 마커로 판정하도록
      // orchestrator가 signal.aborted 자체로 분기하므로 raw 값은 참고용).
      const onAbort = (): void => finish({ text, costUsd, isError: true, raw: 'aborted' });
      if (opts?.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort);
      }

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
          if (opts?.onTool) {
            for (const name of extractToolUseNames(ev)) {
              toolSeq++;
              try { opts.onTool(name, toolSeq); } catch { /* 격리 — UI 콜백 실패가 파싱 루프를 끊으면 안 됨 */ }
            }
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
