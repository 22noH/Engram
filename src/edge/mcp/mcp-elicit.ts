import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';

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

// ★회귀 수정 2탄(2026-07-26) — "decline인데 사람이 답한 게 아닌 경우".
//
// 실사고: 바깥 Claude Code(자동모드)에서 wiki_propose가 3회 연속 "the user declined"로 돌아왔다.
// 사람은 아무것도 누른 적이 없다 — 승인창 자체가 뜨지 않았다. 그 클라이언트는 사람에게 물어볼 수
// 없을 때 `cancel`이 아니라 **`decline`으로 답한다**. 아래 cancel 분기는 "사람이 없어서 자동 응답한
// 것일 수 있다"를 이미 처리하고 있었는데, decline으로 답하는 클라이언트는 그 처리를 못 받아
// "사람이 거부했다"로 읽혔고 제안조차 만들어지지 않았다(= 그 클라이언트에선 위키 저장이 영영 불가).
//
// 판별: **사람이 답하기에 물리적으로 불가능한 속도**. 승인창엔 제목·대상·본문 400자 미리보기가 뜬다
// — 그걸 읽고 누르는 데 1초 미만은 나올 수 없다. 앞선 실측에서 헤드리스 claude는 6ms에 답했다.
// 이 문턱보다 빠른 부정 응답은 "사람이 거부"가 아니라 "물어볼 사람이 없었다"로 읽는다.
//
// ponytail: 지연시간 휴리스틱이다. 천장 — 사람이 진짜로 1초 안에 Cancel을 눌렀다면 그 거부를
// 놓친다(그래도 제안 큐까지만 가고 게시는 앱 승인함이 또 막으므로 피해가 없다). 클라이언트가
// "사람 없음"을 프로토콜로 알리는 표준이 생기면 이 휴리스틱을 그걸로 교체한다.
export const ELICIT_HUMAN_MIN_MS_ENV = 'ENGRAM_MCP_ELICIT_HUMAN_MIN_MS';
export const DEFAULT_ELICIT_HUMAN_MIN_MS = 1_000;

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

// 0도 유효한 설정값이다(문턱 끄기) — >0이 아니라 >=0으로 받는다.
function humanMinMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env[ELICIT_HUMAN_MIN_MS_ENV]);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_ELICIT_HUMAN_MIN_MS;
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
    // ★문구 정정(2026-07-30): '(queued as a proposal)'이라 적어 뒤에 검토 단계가 또 있는 것처럼
    // 오해시켰다. 실제로는 이 창에서 저장을 누르는 순간 게시된다(engram-mcp.ts의 accept 분기가
    // 곧바로 approve까지 한다). 되돌릴 큐가 없으므로 사실대로 말한다.
    `Action: ${what}${req.op === 'propose' ? ' — saved right away when you accept' : ''}`,
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

// form 지원 판정(2026-07-27).
//
// ⚠️먼저 사실 하나 — **빈 `elicitation:{}` 선언은 여기까지 오지 않는다.** SDK가 initialize를 파싱할
// 때 `{}`를 `{form:{}}`로 정규화하고(types.js의 ElicitationCapabilitySchema z.preprocess),
// getClientCapabilities()는 그 파싱된 값을 준다. 실측:
//   {} -> {form:{}} · {form:{}} -> {form:{}} · {url:{}} -> {url:{}} · {applyDefaults:true} -> 그대로
// 그래서 옛 검사(`!!caps?.elicitation?.form`)도 빈 선언 클라이언트는 통과시켰다 —
// "빈 선언이라 요청조차 안 보냈다"는 처음 세운 가설은 **반증됐다**(그 가설로 이 코드를 짰었다).
//
// 그럼 이 분기가 실제로 잡는 건 뭔가: `form`도 `url`도 없는 **비어 있지 않은** 선언(예:
// `{applyDefaults:true}`)이다. 사양상 그것도 form 지원인데 SDK의 elicitInput은 `.form`을 요구하며
// throw하므로(SDK가 사양보다 엄격), 그때만 헬퍼를 우회해 elicitation/create를 직접 보낸다.
//
// ⚠️raw 경로의 대가: elicitInput이 하던 응답 content의 requestedSchema 검증이 사라진다. 즉 raw는
// 사람 게이트가 한 겹 얇다. 우회는 "헬퍼가 막을 때"의 최후 수단이지 기본값이 아니다.
// (capability 검사는 enforceStrictCapabilities를 켠 적이 없어 raw 경로에 아예 걸리지 않는다.)
type FormElicit = 'sdk' | 'raw' | 'none';

export function formElicitationMode(server: Pick<Server, 'getClientCapabilities'>): FormElicit {
  const el = (server.getClientCapabilities() as { elicitation?: { form?: unknown; url?: unknown } } | undefined)
    ?.elicitation;
  if (!el) return 'none';
  if (el.form !== undefined) return 'sdk';
  if (el.url !== undefined) return 'none'; // url 전용 = form 미지원
  return 'raw';
}

type ElicitServer = Pick<Server, 'getClientCapabilities' | 'elicitInput' | 'request'>;

// form elicitation 1회. 물어볼 수 없으면 null(=기존 경로). 예외는 호출자가 흡수한다.
async function elicitForm(
  server: ElicitServer,
  params: ElicitRequestFormParams,
  timeout: number,
): Promise<ElicitResult | null> {
  const mode = formElicitationMode(server);
  if (mode === 'none') return null;
  // 진행 알림으로 타임아웃이 무한 연장되지 않게(무한대기 절대 금지).
  const opts = { timeout, resetTimeoutOnProgress: false };
  if (mode === 'sdk') return server.elicitInput(params, opts);
  return server.request({ method: 'elicitation/create', params }, ElicitResultSchema, opts);
}

// 저장 확정 전 사용자 승인 요청. never-throw — 어떤 실패도 'unavailable'(기존 경로)로 흡수한다.
export async function confirmWikiSave(
  server: ElicitServer,
  req: WikiSaveRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SaveConfirm> {
  if (env[ELICIT_OFF_ENV]) return 'unavailable';
  // ★앱 내부 호출이면 묻지 않는다(위 주석). 승인은 앱 승인함이 한다 — 게이트는 '추가'지 '대체'가
  // 아니라는 원칙 그대로, 이미 사람 게이트가 있는 경로에 두 번째 게이트를 얹지 않는다.
  if (isEngramAppCall(env)) return 'unavailable';
  if (isElicitationDisabled(server)) return 'unavailable';
  const startedAt = Date.now();
  try {
    const result = await elicitForm(server, saveConfirmParams(req), elicitTimeoutMs(env));
    if (result === null) return 'unavailable';
    if (result.action === 'accept') {
      const decision = result.content?.decision;
      // 스키마상 'save' | 'cancel'. 값이 없으면(느슨한 클라이언트) accept=승인으로 본다.
      return decision === 'cancel' ? 'decline' : 'accept';
    }
    // 'decline' = 사람이 명시적으로 거부(MCP 규약) → 저장하지 않는다.
    // 단, 사람이 읽고 누를 수 없는 속도로 돌아온 decline은 "물어볼 사람이 없었다"로 읽는다
    // (위 ELICIT_HUMAN_MIN_MS_ENV 주석 — 실측 6ms 자동 응답 사례). 그때는 아래 cancel과 같은 취급:
    // 제안은 기존 경로로 폴백, 즉시 게시(write)는 애매함을 승인으로 바꾸지 않는다.
    if (result.action === 'decline') {
      const answeredByHuman = Date.now() - startedAt >= humanMinMs(env);
      if (answeredByHuman) return 'decline';
      return req.op === 'write' ? 'decline' : 'unavailable';
    }
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
  server: ElicitServer,
  req: SettingChangeRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SaveConfirm> {
  if (env[ELICIT_OFF_ENV]) return 'unavailable';
  if (isElicitationDisabled(server)) return 'unavailable';
  try {
    const result = await elicitForm(server, settingConfirmParams(req), elicitTimeoutMs(env));
    if (result === null) return 'unavailable';
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
