import { Injectable } from '@nestjs/common';
import { BrainProvider, BrainResult, CompleteOpts, DelegateHandle } from './brain.port';
import { BrainProfile } from './brain.config';
import { Semaphore } from './semaphore';
import { sseJson } from './sse';
import { runToolLoop, ToolCall, TurnResult } from './tool-loop';
import { WEB_TOOL_DEFS, executeWebTool } from './web-tools';
import { askBrainDef, runAskBrain } from './brain-tools';

// OpenAI호환 chat/completions 하네스(스펙 §2.2) — Ollama·LM Studio·vLLM·OpenAI 공용.
// 모델이 tool calling을 지원 안 하면 tool_calls가 안 올 뿐(기능 저하이지 에러 아님).
const DEFAULT_MAX_TOKENS = 16000;

type OpenAiMsg = {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

function fail(raw: string): BrainResult {
  return { text: '', costUsd: 0, isError: true, raw };
}

@Injectable()
export class OpenAiApiBrain implements BrainProvider {
  private readonly sem: Semaphore;

  constructor(
    private readonly profile: BrainProfile,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.sem = new Semaphore(profile.concurrency);
  }

  complete(prompt: string, onChunk?: (text: string) => void, opts?: CompleteOpts): Promise<BrainResult> {
    return this.sem.run(async () => {
      if (opts?.cwd) return fail('coding requires a CLI-harness brain until Phase 8b (opts.cwd rejected)');
      if (!this.profile.baseUrl) return fail('openai-api: baseUrl missing in brains.json profile');
      if (!this.profile.model) return fail('openai-api: model missing in brains.json profile');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? this.profile.timeoutMs);
      const history: OpenAiMsg[] = [{ role: 'user', content: prompt }];
      try {
        const r = await runToolLoop(
          () => this.turn(history, onChunk, ctrl.signal, opts?.delegate),
          (results) => {
            for (const t of results) history.push({ role: 'tool', content: t.output, tool_call_id: t.id });
          },
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

  private async turn(history: OpenAiMsg[], onChunk: ((t: string) => void) | undefined, signal: AbortSignal, delegate?: DelegateHandle): Promise<TurnResult> {
    const toolDefs = [...WEB_TOOL_DEFS, ...(delegate ? [askBrainDef(delegate.brains)] : [])];
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.profile.apiKey) headers.Authorization = `Bearer ${this.profile.apiKey}`;
    const res = await this.fetchFn(`${this.profile.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.profile.model,
        max_tokens: this.profile.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
        stream_options: { include_usage: true }, // usage 미지원 서버면 그 청크가 안 올 뿐(토큰 0)
        messages: history,
        tools: toolDefs.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } })),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const pending = new Map<number, { id: string; name: string; args: string }>();
    for await (const ev of sseJson(res.body)) {
      const usage = ev.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      if (usage) {
        inputTokens = Number(usage.prompt_tokens ?? 0);
        outputTokens = Number(usage.completion_tokens ?? 0);
      }
      const delta = (ev.choices as Array<{ delta?: Record<string, unknown> }> | undefined)?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        onChunk?.(delta.content);
      }
      const calls = delta.tool_calls as Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined;
      for (const c of calls ?? []) {
        const slot = pending.get(c.index) ?? { id: '', name: '', args: '' };
        if (c.id) slot.id = c.id;
        if (c.function?.name) slot.name = c.function.name;
        if (c.function?.arguments) slot.args += c.function.arguments;
        pending.set(c.index, slot);
      }
    }

    const toolCalls: ToolCall[] = [];
    const rawCalls: NonNullable<OpenAiMsg['tool_calls']> = [];
    for (const t of pending.values()) {
      let input: unknown = {};
      try {
        input = t.args ? JSON.parse(t.args) : {};
      } catch {
        // 오염된 인자 → 빈 객체(도구가 에러 텍스트로 응답)
      }
      toolCalls.push({ id: t.id, name: t.name, input });
      rawCalls.push({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } });
    }

    history.push({
      role: 'assistant',
      content: text || null,
      ...(rawCalls.length > 0 ? { tool_calls: rawCalls } : {}),
    });

    return { text, toolCalls, inputTokens, outputTokens };
  }
}
