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

// ★회귀 수정(2026-07-25) — "앱 내부 호출엔 대화상자를 걸지 않는다".
//
// 실사고: 앱 채팅에서 "저장해라"가 계속 "저장 취소됐습니다"로 돌아왔다. 원인은 엔그램 앱의 두뇌도
// MCP 클라이언트라는 사실이다 — 앱은 턴마다 `claude -p`(헤드리스)를 스폰하고, 그 claude가 이
// MCP 서버(stdio 브리지/헤드리스)를 자식으로 띄운다. 실측(2026-07-25, claude 2.1.218): 헤드리스
// claude는 elicitation.form capability를 **선언은 하면서** 요청이 오면 6ms 만에
// {action:'cancel'}로 답한다(사람이 없으니 대화상자를 못 띄운다). 우리는 그걸 "사용자가 거부"로
// 읽어 제안조차 만들지 않았다 = 앱에서의 모든 위키 저장이 막혔다.
//
// 설계 오류의 본질: 앱에서 승인 주체는 이미 **앱의 승인함(제안 큐)** 이다. 거기에 대화상자를 하나
// 더 끼워 이중 게이트가 됐고, 하필 답할 사람이 없는 쪽에 게이트가 걸렸다.
//
// 판별: 이 MCP 프로세스가 상주 앱의 프로세스 트리에서 태어났는가. 상주(src/main.ts bootstrap)는
// 자기 env에 ENGRAM_RESIDENT=1을 심고, 두뇌 스폰이 env를 통째로 물려주며(claude-cli.brain.ts),
// claude가 띄우는 MCP 자식도 그 env를 그대로 본다(ba16f22에서 ENGRAM_CHANNEL_ID로 실측 확인된
// 바로 그 경로). 그 턴의 채널 정체성(ENGRAM_CHANNEL_ID)이 실렸으면 두말할 것 없이 앱 내부다.
// 헤드리스(mcp-headless.ts)는 ENGRAM_RESIDENT를 절대 세팅하지 않으므로 외부 사용자 경로와 섞이지
// 않는다.
export const APP_RESIDENT_ENV = 'ENGRAM_RESIDENT';
export const APP_CHANNEL_ENV = 'ENGRAM_CHANNEL_ID';

export function isEngramAppCall(env: NodeJS.ProcessEnv): boolean {
  return !!(env[APP_RESIDENT_ENV] ?? '').trim() || !!(env[APP_CHANNEL_ENV] ?? '').trim();
}

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
  // ★앱 내부 호출이면 묻지 않는다(위 주석). 승인은 앱 승인함이 한다 — 게이트는 '추가'지 '대체'가
  // 아니라는 원칙 그대로, 이미 사람 게이트가 있는 경로에 두 번째 게이트를 얹지 않는다.
  if (isEngramAppCall(env)) return 'unavailable';
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
    // 'decline' = 사람이 명시적으로 거부(MCP 규약) → 저장하지 않는다.
    if (result.action === 'decline') return 'decline';
    // 'cancel' = **명시적 선택 없이 닫힘**. 사람이 ESC를 눌렀을 수도, 사람이 아예 없어서
    // 클라이언트가 자동으로 답했을 수도 있다(헤드리스 claude -p 실측이 바로 이 경우) — 거부 의사로
    // 읽으면 안 된다. 제안 경로는 기존 경로(제안 큐, 앱에서 사람이 승인)로 폴백하고, 즉시 게시
    // (wiki_write)는 폴백이 곧 게시라 애매함을 절대 승인으로 바꾸지 않는다(거부 쪽이 안전).
    return req.op === 'write' ? 'decline' : 'unavailable';
  } catch {
    // 미지원·타임아웃·전송 실패 전부 — 조용히 기존 경로로.
    return 'unavailable';
  }
}

// ── 위험한 설정 변경 승인(2026-07-25) ────────────────────────────────────────
// 저장 승인과 같은 대화상자 메커니즘을 재사용하되 **폴백 규칙이 정반대**다.
//  - 위키 저장: 못 물어보면(unavailable) 기존 경로로 조용히 진행(게이트는 '추가'였다).
//  - 설정 변경: 못 물어보면 **거부**한다 — "AI에게 말로 설정"을 열어준 대가로, 사람이 볼 수 없는
//    맥락에서 위키 원격 주소나 승인 우회 스위치가 조용히 바뀌는 일은 절대 없어야 한다.
//    (그 판정은 호출자(mcp-settings.ts)가 하고, 여기선 승인 결과만 정직하게 돌려준다.)
//  - 그래서 isEngramAppCall(앱 내부 호출이면 묻지 않기)도 **여기엔 적용하지 않는다** — 앱의 두뇌가
//    말로 위험 설정을 바꾸는 길을 열어주는 셈이 되기 때문. 앱 내부 호출은 물어보고, 답이 없으면
//    거부된다(설정에는 앱 승인함 같은 대체 게이트가 없다).
export interface SettingChangeRequest {
  key: string;
  /** 현재 값(빈 문자열 = 미설정). */
  from: string;
  to: string;
  /** 왜 위험한지 한 문장. */
  reason: string;
}

function shownValue(v: string): string {
  return v === '' ? '(not set)' : v;
}

export function settingConfirmMessage(req: SettingChangeRequest): string {
  return [
    'Change an Engram setting?',
    '',
    `Setting: ${req.key}`,
    `From: ${shownValue(req.from)}`,
    `To: ${shownValue(req.to)}`,
    '',
    `Why you are being asked: ${req.reason}`,
  ].join('\n');
}

export function settingConfirmParams(req: SettingChangeRequest): ElicitRequestFormParams {
  return {
    mode: 'form',
    message: settingConfirmMessage(req),
    requestedSchema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          title: `Change ${req.key}?`,
          description: `${shownValue(req.from)} -> ${shownValue(req.to)} — ${req.reason}`,
          enum: ['change', 'cancel'],
          enumNames: ['Change it', 'Cancel'],
          // 저장 승인과 달리 기본값은 취소 — 위험한 쪽이 기본이 되면 안 된다.
          default: 'cancel',
        },
      },
      required: ['decision'],
    },
  };
}

// never-throw. 'unavailable'은 "물어볼 수 없었다"이며, 설정 경로에선 곧 거부 사유가 된다.
export async function confirmSettingChange(
  server: Pick<Server, 'getClientCapabilities' | 'elicitInput'>,
  req: SettingChangeRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SaveConfirm> {
  if (env[ELICIT_OFF_ENV]) return 'unavailable';
  if (isElicitationDisabled(server)) return 'unavailable';
  if (!supportsFormElicitation(server)) return 'unavailable';
  try {
    const result = await server.elicitInput(settingConfirmParams(req), {
      timeout: elicitTimeoutMs(env),
      resetTimeoutOnProgress: false,
    });
    if (result.action === 'accept') {
      // 값이 없으면(느슨한 클라이언트) 승인으로 보지 않는다 — 설정 변경은 명시 승인만 인정.
      return result.content?.decision === 'change' ? 'accept' : 'decline';
    }
    return 'decline';
  } catch {
    return 'unavailable';
  }
}

// 사용자가 거부했을 때 도구가 돌려줄 결과 텍스트(에러가 아니라 명확한 결과).
export function declinedText(req: WikiSaveRequest): string {
  return `cancelled: the user declined to ${req.op === 'write' ? 'publish' : 'save'} "${req.title}" to the Engram wiki — nothing was ${req.op === 'write' ? 'written' : 'proposed'}.`;
}
