import { Injectable } from '@nestjs/common';
import { BrainProvider, BrainResult, CompleteOpts } from './brain.port';
import { BrainProfile } from './brain.config';
import { Semaphore } from './semaphore';
import { sseJson } from './sse';
import { runToolLoop, ToolCall, TurnResult, MAX_TOOL_ITERATIONS } from './tool-loop';
import { WEB_TOOL_DEFS, WebToolDef, executeWebTool } from './web-tools';
import { askBrainDef, runAskBrain } from './brain-tools';
import { askUserDef, runAskUser } from './ask-user-tool';
import { CODING_TOOL_DEFS, executeCodingTool, MAX_CODING_ITERATIONS } from './coding-tools';
import { BASH_TOOL_DEF, runShellTool } from './shell-tool';
import { McpSession, MCP_TOOL_PREFIX } from './mcp-client';
import { loadMcpServers } from './mcp-config';

// OpenAI호환 chat/completions 하네스(스펙 §2.2) — Ollama·LM Studio·vLLM·OpenAI 공용.
// 모델이 tool calling을 지원 안 하면 tool_calls가 안 올 뿐(기능 저하이지 에러 아님).
const DEFAULT_MAX_TOKENS = 16000;

type OpenAiMsg = {
  role: 'user' | 'assistant' | 'tool';
  // Task 3(chat-attachments): 초기 user 턴에 vision 이미지(image_url)를 싣기 위해 배열 타입도 허용
  // (미첨부 경로는 기존과 동일하게 string — 요청 바디 byte-identical, 회귀 0).
  content: string | null | Array<Record<string, unknown>>;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

function fail(raw: string): BrainResult {
  return { text: '', costUsd: 0, isError: true, raw };
}

@Injectable()
export class OpenAiApiBrain implements BrainProvider {
  readonly canDelegate = true; // 엔그램 자체 하네스 — ask_brain 위임 지원(Phase 8d)
  private readonly sem: Semaphore;

  constructor(
    private readonly profile: BrainProfile,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly configDir?: string, // 8c-1: mcp.json 위치. 없으면 MCP 비활성(하위호환).
  ) {
    this.sem = new Semaphore(profile.concurrency);
  }

  complete(prompt: string, onChunk?: (text: string) => void, opts?: CompleteOpts): Promise<BrainResult> {
    return this.sem.run(async () => {
      // 코딩(opts.cwd)엔 쓰기 판정(codeGuard, agent-layer 주입)이 필수 — 없으면 무방비 쓰기라 거부(스펙 §6.2·불변식 4).
      const coding = !!opts?.cwd;
      if (coding && !opts!.codeGuard) return fail('coding requires an injected codeGuard (PermissionFence)');
      if (!this.profile.baseUrl) return fail('openai-api: baseUrl missing in brains.json profile');
      if (!this.profile.model) return fail('openai-api: model missing in brains.json profile');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? this.profile.timeoutMs);
      // Task 4(여러 줄 입력+생성 중지): anthropic-api와 동일 결 — 외부 signal을 내부 타임아웃 ctrl에 전파.
      const onExternalAbort = (): void => ctrl.abort();
      if (opts?.signal) {
        if (opts.signal.aborted) ctrl.abort();
        else opts.signal.addEventListener('abort', onExternalAbort);
      }
      // Task 3(chat-attachments): opts.images 있으면 초기 user 턴을 텍스트+image_url(data URL) 배열로
      // (vision — OpenAI 호환 서버가 지원 안 하면 기존 에러 경로로 떨어질 뿐, 폴백 시도는 하지 않는다).
      // 없으면 content: prompt 그대로(회귀 0).
      const history: OpenAiMsg[] = [{
        role: 'user',
        content: opts?.images?.length
          ? [
              { type: 'text', text: prompt },
              ...opts.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.dataBase64}` } })),
            ]
          : prompt,
      }];
      const toolDefs: WebToolDef[] = coding
        ? [...CODING_TOOL_DEFS, ...(opts!.cmdGuard ? [BASH_TOOL_DEF] : [])]
        : [...WEB_TOOL_DEFS, ...(opts?.delegate ? [askBrainDef(opts.delegate.brains)] : []), ...(opts?.askUser ? [askUserDef()] : [])];
      // 8c-1: mcp.json 서버의 도구를 채팅·코딩 공통 toolDefs 끝에 병합(라우팅은 mcp__ 프리픽스 우선 판정).
      const mcpSessions: McpSession[] = [];
      const executor = (name: string, input: unknown): Promise<string> => {
        if (name.startsWith(MCP_TOOL_PREFIX)) {
          const s = mcpSessions.find((x) => x.owns(name));
          return s ? s.callTool(name, input) : Promise.resolve(`mcp error: unknown tool ${name}`);
        }
        return coding
          ? name === 'Bash'
            ? runShellTool(input, opts!.cwd!, opts!.cmdGuard!, ctrl.signal)
            : executeCodingTool(name, input, opts!.cwd!, opts!.codeGuard!, ctrl.signal)
          : name === 'ask_brain' ? runAskBrain(input, opts?.delegate)
          : name === 'ask_user' ? runAskUser(input, opts?.askUser)
          : executeWebTool(name, input, this.profile, this.fetchFn, ctrl.signal);
      };
      try {
        if (this.configDir) {
          for (const [name, cfg] of Object.entries(loadMcpServers(this.configDir))) {
            const s = McpSession.create(name, cfg);
            if (await s.connect()) {
              mcpSessions.push(s);
              toolDefs.push(...(await s.listToolDefs()));
            } else {
              await s.close();
            }
          }
        }
        const r = await runToolLoop(
          () => this.turn(history, onChunk, ctrl.signal, toolDefs),
          (results) => {
            for (const t of results) history.push({ role: 'tool', content: t.output, tool_call_id: t.id });
          },
          executor,
          coding ? MAX_CODING_ITERATIONS : MAX_TOOL_ITERATIONS,
          opts?.onTool,
        );
        return {
          text: r.text,
          costUsd: this.cost(r.inputTokens, r.outputTokens),
          isError: false,
          ...(r.hitLimit ? { raw: 'tool-loop-limit' } : {}),
        };
      } catch (e) {
        return fail(opts?.signal?.aborted ? 'aborted' : ctrl.signal.aborted ? 'timeout' : String(e));
      } finally {
        clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onExternalAbort);
        await Promise.all(mcpSessions.map((s) => s.close()));
      }
    });
  }

  private cost(inTok: number, outTok: number): number {
    return (inTok * (this.profile.inputUsdPerMTok ?? 0) + outTok * (this.profile.outputUsdPerMTok ?? 0)) / 1_000_000;
  }

  private async turn(history: OpenAiMsg[], onChunk: ((t: string) => void) | undefined, signal: AbortSignal, toolDefs: WebToolDef[]): Promise<TurnResult> {
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
