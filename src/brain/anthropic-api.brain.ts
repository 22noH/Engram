import { Injectable } from '@nestjs/common';
import { BrainProvider, BrainResult, CompleteOpts, DelegateHandle } from './brain.port';
import { BrainProfile } from './brain.config';
import { Semaphore } from './semaphore';
import { sseJson } from './sse';
import { runToolLoop, ToolCall, TurnResult } from './tool-loop';
import { WEB_TOOL_DEFS, executeWebTool } from './web-tools';
import { askBrainDef, runAskBrain } from './brain-tools';

// Anthropic Messages API 직접 호출 하네스(스펙 §2.1). 공식 SDK 미도입 — HTTP+SSE 직접.
// ponytail: SDK의 재시도·타이핑이 필요해지면 도입 재검토.
const DEFAULT_BASE = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 16000;

type AnthropicMsg = { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> };

function fail(raw: string): BrainResult {
  return { text: '', costUsd: 0, isError: true, raw };
}

@Injectable()
export class AnthropicApiBrain implements BrainProvider {
  private readonly sem: Semaphore;

  constructor(
    private readonly profile: BrainProfile,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.sem = new Semaphore(profile.concurrency);
  }

  complete(prompt: string, onChunk?: (text: string) => void, opts?: CompleteOpts): Promise<BrainResult> {
    return this.sem.run(async () => {
      // 코딩 신호(opts.cwd)는 8b까지 CLI 하네스 전용 — 조용한 품질저하 대신 정직한 거부(스펙 §2.3).
      if (opts?.cwd) return fail('coding requires a CLI-harness brain until Phase 8b (opts.cwd rejected)');
      if (!this.profile.apiKey) return fail('anthropic-api: apiKey missing in brains.json profile');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? this.profile.timeoutMs);
      const history: AnthropicMsg[] = [{ role: 'user', content: prompt }];
      try {
        const r = await runToolLoop(
          () => this.turn(history, onChunk, ctrl.signal, opts?.delegate),
          (results) => history.push({
            role: 'user',
            content: results.map((t) => ({ type: 'tool_result', tool_use_id: t.id, content: t.output })),
          }),
          (name, input) => name === 'ask_brain'
            ? runAskBrain(input, opts?.delegate)
            : executeWebTool(name, input, this.profile, this.fetchFn, ctrl.signal),
        );
        return {
          text: r.text,
          costUsd: this.cost(r.inputTokens, r.outputTokens),
          isError: false,
          ...(r.hitLimit ? { raw: 'tool-loop-limit' } : {}),
        };
      } catch (e) {
        return fail(ctrl.signal.aborted ? 'timeout' : String(e));
      } finally {
        clearTimeout(timer);
      }
    });
  }

  private cost(inTok: number, outTok: number): number {
    return (inTok * (this.profile.inputUsdPerMTok ?? 0) + outTok * (this.profile.outputUsdPerMTok ?? 0)) / 1_000_000;
  }

  // 한 턴 = 모델 호출 1회. SSE에서 텍스트(onChunk)·tool_use·usage를 수집하고 assistant 턴을 history에 기록.
  private async turn(history: AnthropicMsg[], onChunk: ((t: string) => void) | undefined, signal: AbortSignal, delegate?: DelegateHandle): Promise<TurnResult> {
    const toolDefs = [...WEB_TOOL_DEFS, ...(delegate ? [askBrainDef(delegate.brains)] : [])];
    const res = await this.fetchFn(`${this.profile.baseUrl || DEFAULT_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.profile.apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.profile.model,
        max_tokens: this.profile.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
        messages: history,
        tools: toolDefs.map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters })),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const pending = new Map<number, { id: string; name: string; json: string }>();
    for await (const ev of sseJson(res.body)) {
      if (ev.type === 'message_start') {
        inputTokens = Number((ev.message as { usage?: { input_tokens?: number } })?.usage?.input_tokens ?? 0);
      } else if (ev.type === 'content_block_start') {
        const b = ev.content_block as { type?: string; id?: string; name?: string };
        if (b?.type === 'tool_use') pending.set(Number(ev.index), { id: String(b.id), name: String(b.name), json: '' });
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta as { type?: string; text?: string; partial_json?: string };
        if (d?.type === 'text_delta' && d.text) {
          text += d.text;
          onChunk?.(d.text);
        } else if (d?.type === 'input_json_delta') {
          const t = pending.get(Number(ev.index));
          if (t) t.json += d.partial_json ?? '';
        }
      } else if (ev.type === 'message_delta') {
        outputTokens += Number((ev.usage as { output_tokens?: number })?.output_tokens ?? 0);
      }
    }

    const toolCalls: ToolCall[] = [];
    for (const t of pending.values()) {
      let input: unknown = {};
      try {
        input = t.json ? JSON.parse(t.json) : {};
      } catch {
        // 오염된 인자 → 빈 객체(도구가 에러 텍스트로 응답해 모델이 재시도)
      }
      toolCalls.push({ id: t.id, name: t.name, input });
    }

    // assistant 턴을 history에 기록(다음 회전의 문맥)
    const blocks: Array<Record<string, unknown>> = [];
    if (text) blocks.push({ type: 'text', text });
    for (const c of toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
    if (blocks.length > 0) history.push({ role: 'assistant', content: blocks });

    return { text, toolCalls, inputTokens, outputTokens };
  }
}
