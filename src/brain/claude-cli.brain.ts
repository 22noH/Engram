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
// stderr는 노이즈가 섞일 수 있어 상한을 둔다(에러 한 줄이면 충분 — 무한 누적 방지).
const STDERR_CAP = 4000;

// 구버전 CLI가 --effort를 모를 때의 사인. commander가 내는 문구가 고정 형식이라 이걸로 판정한다
// (`error: unknown option '--effort'` — 이 머신 claude 2.1.218로 실측 확인).
function isUnknownEffortOption(r: BrainResult): boolean {
  return r.isError && /unknown option[^\n]*--effort/i.test(String(r.raw ?? ''));
}

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

  // --effort는 최신 claude CLI에만 있다. 구버전은 "unknown option"으로 즉시 죽어 전 채팅이 깨지므로
  // (실사고 대비 2026-07-25) 한 번 감지되면 이 프로세스 수명 동안 effort를 안 붙인다. 프로필별
  // 인스턴스가 여러 개라 static — CLI 실행파일이 달라도 최신이면 이 플래그가 켜질 일 자체가 없다.
  private static effortUnsupported = false;

  complete(prompt: string, onChunk?: (text: string) => void, opts?: CompleteOpts): Promise<BrainResult> {
    return this.sem.run(async () => {
      const r = await this.spawnOnce(prompt, onChunk, opts);
      // 미지원 감지 → effort 빼고 딱 1회 재시도(사용자는 아무것도 못 느끼게 자동 복구).
      if (opts?.effort && !ClaudeCliBrain.effortUnsupported && isUnknownEffortOption(r)) {
        ClaudeCliBrain.effortUnsupported = true;
        const { effort: _dropped, ...rest } = opts;
        return this.spawnOnce(prompt, onChunk, rest);
      }
      return r;
    });
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
      // 노력(effort): --allowedTools와 같은 결 — 프로필/호출이 --effort를 직접 주면 사용자 의도가
      // 우선이라 중복으로 안 붙인다. opts.effort 미주입이면 인수 자체가 안 생긴다(회귀 0).
      const hasEffort = extra.includes('--effort') || ClaudeCliBrain.effortUnsupported;
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        ...(this.profile.model ? ['--model', this.profile.model] : []),
        ...(hasAllowed ? [] : ['--allowedTools', buildAllowedTools()]),
        ...(opts?.effort && !hasEffort ? ['--effort', opts.effort] : []),
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
      // 두뇌 실패 사유 표면화: CLI가 실은 원본 에러 텍스트(예: "Not logged in · Please run /login")를
      // 그대로 보관 — 성공 시엔 절대 채워지지 않으므로(close 핸들러가 isError일 때만 raw에 얹음)
      // 성공 경로 BrainResult는 바이트 동일(회귀 0). assistant 이벤트의 top-level error 필드(예:
      // "authentication_failed")가 먼저 오고 최종 result 이벤트의 is_error+result가 뒤따르는 실사고
      // 순서를 그대로 따라 — 최종 result 텍스트를 주 문구로, 먼저 본 에러 코드를 괄호로 덧붙인다.
      let errorRaw: string | undefined;
      // stderr는 지금껏 아무도 안 읽었다(실사고 대비 2026-07-25): CLI가 인수 오류 등으로 stream-json을
      // 한 줄도 못 내고 죽으면 result 이벤트가 없어 isError=false·text=''인 "빈 성공"이 돌아갔다 —
      // 사용자에겐 이유 없는 빈 답. 여기 모아뒀다가 결과가 하나도 없을 때만 사유로 승격한다
      // (정상 응답이 온 경우엔 경고성 stderr가 있어도 기존 동작 그대로 = 회귀 0).
      let stderrBuf = '';

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
          if (typeof ev.error === 'string' && ev.error && !errorRaw) errorRaw = ev.error;
          if (ev.type === 'result') {
            costUsd = Number(ev.total_cost_usd ?? 0);
            isError = Boolean(ev.is_error);
            if (typeof ev.result === 'string') {
              text = ev.result; // 최종 권위 텍스트로 교체
              if (isError) errorRaw = errorRaw && errorRaw !== ev.result ? `${ev.result} (${errorRaw})` : ev.result;
            }
          }
        }
      });

      child.stderr?.on('data', (d: Buffer) => {
        if (stderrBuf.length < STDERR_CAP) stderrBuf += d.toString();
      });

      child.on('error', (err: NodeJS.ErrnoException) =>
        finish({ text: '', costUsd: 0, isError: true, raw: err?.code ? `spawn-error: ${err.code}` : `spawn-error: ${err?.message ?? 'unknown'}` }));
      child.on('close', () => {
        // 결과 이벤트도 텍스트도 없이 끝났다면 정상 응답이 아니다 — stderr가 있으면 그게 유일한 단서다.
        if (!isError && !text && stderrBuf.trim()) {
          finish({ text: '', costUsd, isError: true, raw: stderrBuf.trim() });
          return;
        }
        finish({ text, costUsd, isError, ...(isError && errorRaw ? { raw: errorRaw } : {}) });
      });
    });
  }
}
