import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ElicitRequestFormParams } from '@modelcontextprotocol/sdk/types.js';

// MCP elicitation 기반 "저장 전 사람 승인"(2026-07-25).
//
// 왜: wiki_propose/wiki_write는 지금까지 "저장 전에 사용자에게 물어라"를 initialize instructions
// 안내문에만 의존했다 — 모델이 무시하면 그냥 저장된다. elicitation(서버가 클라이언트에 사용자 입력을
// 요청하는 MCP 표준)은 클라이언트가 실제 대화상자를 띄우므로 안내문이 아니라 프로토콜 차원의 게이트가
// 된다(Claude Code 2.1.76+·Codex v0.119+ 지원).
//
// ★설계 원칙: 게이트는 '추가'지 '대체'가 아니다. 클라이언트가 elicitation을 지원하지 않거나(대다수
// 구형), 요청이 실패·타임아웃되면 조용히 기존 경로(제안만 만들고 사람이 앱에서 승인)로 되돌아간다
// — 미지원 클라이언트 동작은 바이트 단위로 동일(회귀 0).
//
// ★무한대기 방지 3중:
//  1) capability 협상 — 클라이언트가 elicitation.form을 선언하지 않으면 아예 요청하지 않는다
//     (사람 없는 헤드리스 클라이언트는 보통 선언하지 않는다 = 사람 없는 맥락 판정).
//  2) transport 차단 — stateless streamable HTTP(mcp-http.ts)는 서버→클라이언트 요청을 실을
//     standalone SSE 스트림이 없어 SDK가 메시지를 조용히 버린다(=영구 대기). 그 경로는
//     disableElicitation()으로 아예 끈다.
//  3) 타임아웃 — 그래도 응답이 없으면 ELICIT_TIMEOUT_ENV(기본 120초) 후 거부가 아니라 폴백.

// 45초 — 클라이언트의 MCP 도구 호출 타임아웃(클로드 코드 기본 60초)보다 반드시 짧아야 한다.
// 더 길면 사용자 화면엔 승인 대화상자가 떠 있는데 도구 호출은 이미 끊긴 뒤라, 눌러도 아무 일이
// 없는 유령 대화상자가 된다(리뷰 지적 2026-07-25). 여유가 필요하면 ELICIT_TIMEOUT_ENV로 올린다.
export const DEFAULT_ELICIT_TIMEOUT_MS = 45_000;
export const ELICIT_TIMEOUT_ENV = 'ENGRAM_MCP_ELICIT_TIMEOUT_MS';
// 탈출구 — 자동화/CI처럼 사람이 없는 게 확실한 맥락에서 대화상자를 아예 끄고 기존 경로로.
export const ELICIT_OFF_ENV = 'ENGRAM_MCP_NO_ELICIT';

const PREVIEW_CHARS = 400;

// 'accept'=사용자가 저장 승인, 'decline'=사용자가 거부(제안 자체를 만들지 않는다),
// 'unavailable'=물어볼 수 없었다(미지원·차단·실패·타임아웃) → 기존 경로 그대로.
export type SaveConfirm = 'accept' | 'decline' | 'unavailable';

export interface WikiSaveRequest {
  title: string;
  content: string;
  slug?: string;
  // propose=제안 대기열(사람이 앱에서 승인), write=즉시 게시(--write-mode).
  op: 'propose' | 'write';
}

// transport 단위 차단 목록. buildMcpServer의 호출자(self.adapter 등)를 건드리지 않고도
// "이 서버 인스턴스는 elicitation 불가"를 표시할 수 있게 WeakSet으로 옆에 붙인다.
const blocked = new WeakSet<object>();

export function disableElicitation(server: object): void {
  blocked.add(server);
}

export function isElicitationDisabled(server: object): boolean {
  return blocked.has(server);
}

function elicitTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env[ELICIT_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ELICIT_TIMEOUT_MS;
}

function preview(content: string): string {
  const flat = content.trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

// 대화상자에 뜨는 문구(제품 UI 기본 언어 = 영어).
export function saveConfirmMessage(req: WikiSaveRequest): string {
  const target = req.slug
    ? `append to the existing page "${req.slug}"`
    : 'create a new page';
  const what = req.op === 'write' ? 'publish to the Engram wiki now' : 'save to the Engram wiki';
  return [
    `Save this to the Engram wiki?`,
    ``,
    `Title: ${req.title}`,
    `Target: ${target}`,
    `Action: ${what}${req.op === 'propose' ? ' (queued as a proposal)' : ''}`,
    ``,
    preview(req.content),
  ].join('\n');
}

export function saveConfirmParams(req: WikiSaveRequest): ElicitRequestFormParams {
  return {
    mode: 'form',
    message: saveConfirmMessage(req),
    requestedSchema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          title: 'Save to the Engram wiki?',
          description: `"${req.title}" — ${req.slug ? `append to ${req.slug}` : 'new page'}`,
          enum: ['save', 'cancel'],
          enumNames: ['Save', 'Cancel'],
          default: 'save',
        },
      },
      required: ['decision'],
    },
  };
}

// elicitation 지원 여부(capability 협상 결과). form 모드만 쓴다 — url 모드만 선언한 클라이언트는
// SDK elicitInput이 throw하므로 여기서 미리 거른다.
function supportsFormElicitation(server: Pick<Server, 'getClientCapabilities'>): boolean {
  const caps = server.getClientCapabilities() as { elicitation?: { form?: unknown } } | undefined;
  return !!caps?.elicitation?.form;
}

// 저장 확정 전 사용자 승인 요청. never-throw — 어떤 실패도 'unavailable'(기존 경로)로 흡수한다.
export async function confirmWikiSave(
  server: Pick<Server, 'getClientCapabilities' | 'elicitInput'>,
  req: WikiSaveRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SaveConfirm> {
  if (env[ELICIT_OFF_ENV]) return 'unavailable';
  if (isElicitationDisabled(server)) return 'unavailable';
  if (!supportsFormElicitation(server)) return 'unavailable';
  try {
    const result = await server.elicitInput(saveConfirmParams(req), {
      timeout: elicitTimeoutMs(env),
      // 진행 알림으로 타임아웃이 무한 연장되지 않게(무한대기 절대 금지).
      resetTimeoutOnProgress: false,
    });
    if (result.action === 'accept') {
      const decision = result.content?.decision;
      // 스키마상 'save' | 'cancel'. 값이 없으면(느슨한 클라이언트) accept=승인으로 본다.
      return decision === 'cancel' ? 'decline' : 'accept';
    }
    // 'decline'(명시 거부)·'cancel'(대화상자 닫음) 모두 저장하지 않는다.
    return 'decline';
  } catch {
    // 미지원·타임아웃·전송 실패 전부 — 조용히 기존 경로로.
    return 'unavailable';
  }
}

// 사용자가 거부했을 때 도구가 돌려줄 결과 텍스트(에러가 아니라 명확한 결과).
export function declinedText(req: WikiSaveRequest): string {
  return `cancelled: the user declined to ${req.op === 'write' ? 'publish' : 'save'} "${req.title}" to the Engram wiki — nothing was ${req.op === 'write' ? 'written' : 'proposed'}.`;
}
