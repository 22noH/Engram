// 코드펜스/잡텍스트에서 첫 균형 잡힌 JSON(객체 또는 배열)을 뽑아 파싱. 실패 시 null.
// 깊이 카운팅 + 문자열 인식 스캐너로 꼬리 산문의 브래킷·문자열 내부 브래킷을 무시한다.
export function parseJsonBlock<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const open = candidate[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)) as T; } catch { return null; }
}
