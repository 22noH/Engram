import type { QuestionItem, QuestionOption } from '../../shared/protocol';

// 범용 경로(Task 3) — 두뇌가 도구 없이도(CLI 하네스·비도구 로컬 LLM 포함) 응답 텍스트에
// ```ask_user 펜스 블록을 실어 보내면 여기서 뽑아 카드로 바꾼다. Task 1의 QuestionItem을 그대로 감싼다.
export interface AskUserPayload { questions: QuestionItem[] }

// 첫 ```ask_user 블록만 매칭(g 플래그 없음 — exec가 첫 매치만 돌려줌). 여러 개면 둘째부터는
// 텍스트에 그대로 남는다 — 카드는 턴당 1장이라는 단순 규칙(브리프 Step 2).
const ASK_USER_BLOCK = /```ask_user[ \t]*\r?\n([\s\S]*?)```/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

// 옵션 하나 검증+정제(알 수 없는 여분 키는 버리고 검증된 필드만으로 새 객체를 만든다).
function cleanOption(o: unknown): QuestionOption | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (!isNonEmptyString(r.label)) return null;
  if (r.desc !== undefined && typeof r.desc !== 'string') return null;
  if (r.recommended !== undefined && typeof r.recommended !== 'boolean') return null;
  const clean: QuestionOption = { label: r.label as string };
  if (typeof r.desc === 'string') clean.desc = r.desc;
  if (typeof r.recommended === 'boolean') clean.recommended = r.recommended;
  return clean;
}

// 질문 하나 검증+정제. options 2~4개, 각 옵션도 cleanOption 통과해야.
function cleanQuestion(q: unknown): QuestionItem | null {
  if (!q || typeof q !== 'object') return null;
  const r = q as Record<string, unknown>;
  if (!isNonEmptyString(r.q)) return null;
  if (r.header !== undefined && typeof r.header !== 'string') return null;
  if (r.multiSelect !== undefined && typeof r.multiSelect !== 'boolean') return null;
  if (!Array.isArray(r.options) || r.options.length < 2 || r.options.length > 4) return null;
  const options: QuestionOption[] = [];
  for (const raw of r.options) {
    const opt = cleanOption(raw);
    if (!opt) return null;
    options.push(opt);
  }
  const clean: QuestionItem = { q: r.q as string, options };
  if (typeof r.header === 'string') clean.header = r.header;
  if (typeof r.multiSelect === 'boolean') clean.multiSelect = r.multiSelect;
  return clean;
}

// 전체 페이로드 검증+정제(공개 API — T3 리뷰: Task 4가 펜스 텍스트가 아닌 원시 도구호출 input(unknown)을
// 검증해야 해서 extractAskUser를 못 거친다. 검증 로직의 단일 소스로 여기 export해 공유·중복 구현 금지).
// questions 1~4개·각 q 비어있지 않은 string·options 2~4개·label 비어있지 않은 string·desc/header는
// string(있다면)·multiSelect/recommended는 boolean(있다면). 규칙 위반이면 null(정제된 부분 반환 없음).
export function validateAskUserPayload(raw: unknown): AskUserPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.questions) || r.questions.length < 1 || r.questions.length > 4) return null;
  const questions: QuestionItem[] = [];
  for (const q of r.questions) {
    const item = cleanQuestion(q);
    if (!item) return null;
    questions.push(item);
  }
  return { questions };
}

// 텍스트에서 ```ask_user\n{JSON}\n``` 블록을 찾아 검증·분리한다. 검증은 validateAskUserPayload
// 하나로(단일 소스) — JSON 파싱 실패나 검증 실패면 원문을 그대로 돌려준다(question 없음) — 두뇌가
// 형식을 틀려도 응답 자체는 유실되지 않는다.
export function extractAskUser(text: string): { text: string; question?: AskUserPayload } {
  const m = ASK_USER_BLOCK.exec(text);
  if (!m) return { text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return { text };
  }
  const question = validateAskUserPayload(parsed);
  if (!question) return { text };
  const stripped = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  return { text: stripped, question };
}

// 카드 UI가 없는 클라이언트(또는 text가 렌더에 쓰이는 경로)를 위한 폴백 본문 —
// 질문 + "1. 라벨 — 설명" 줄들. reply의 text 인자로 그대로 쓸 수 있게 문자열 하나로 합친다.
export function questionFallbackText(q: AskUserPayload): string {
  return q.questions
    .map((item) => {
      const lines = item.options.map((o, i) => `${i + 1}. ${o.label}${o.desc ? ` — ${o.desc}` : ''}`);
      return [item.q, ...lines].join('\n');
    })
    .join('\n\n');
}
