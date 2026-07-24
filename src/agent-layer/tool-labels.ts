import { configuredLang } from './language';

// 두뇌 활동 표시(Task 1): 도구 이름 → 사람이 읽는 활동 라벨(순수 함수, 부수효과 0). 알려진 종류는
// 로케일 문구, 그 외(MCP 접두 포함 미지의 이름)는 이름 그대로 반환한다 — 크래시도 누락도 없다.
// 서버 로케일 관례(agent-layer의 t(), i18n.ts)를 그대로 따르되, tool-loop·claude-cli 양쪽 하네스가
// 부르는 onTool 콜백에서 즉시 문자열로 써야 해 별도 순수 모듈로 둔다(agent-layer→brain 계층 역전 방지 —
// brain.port.ts의 CompleteOpts.askUser와 같은 이유로 이쪽(agent-layer)에서만 참조).

type LabelEntry = { en: string; ko: string };

// Bash·코딩 도구(permission-fence.ts CODING_TOOLS + shell-tool.ts BASH_TOOL_DEF)는 "코드 작업"으로 묶는다.
const CODING_TOOL_NAMES = new Set(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
const CODING_LABEL: LabelEntry = { en: 'Working on code', ko: '코드 작업 중' };

const KNOWN: Record<string, LabelEntry> = {
  wiki_search: { en: 'Searching the wiki', ko: '위키 검색 중' },
  web_search: { en: 'Searching the web', ko: '웹 검색 중' },
  fetch_url: { en: 'Reading a page', ko: '페이지 읽는 중' },
  ask_brain: { en: 'Delegating to another model', ko: '다른 모델에 위임 중' },
  ask_user: { en: 'Posting a question', ko: '질문 게시 중' },
};

// name 그대로 반환하는 경우(미지·MCP 접두 mcp__*)엔 호출부(reader-agent)가 이름을 중복해 붙이지 않도록
// 라벨==이름을 그대로 돌려준다 — reader-agent의 조립 규칙(label과 이름이 같으면 " · 이름" 생략)과 짝이다.
export function toolLabel(name: string, lang: string = configuredLang()): string {
  if (CODING_TOOL_NAMES.has(name)) return lang === 'ko' ? CODING_LABEL.ko : CODING_LABEL.en;
  const entry = KNOWN[name];
  if (entry) return lang === 'ko' ? entry.ko : entry.en;
  return name; // 미지의 이름·MCP 접두 = 이름 그대로(절대 누락 크래시 없음)
}
