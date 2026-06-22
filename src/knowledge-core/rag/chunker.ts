// 위키 본문을 검색 단위(청크)로 나눈다.
// 문단(빈 줄) 경계를 유지하며 maxChars 한도까지 누적한다.
// 마크다운 헤딩도 보통 빈 줄로 구분되므로 별도 헤딩 파싱은 하지 않는다(YAGNI).
const DEFAULT_MAX_CHARS = 1200;

export function chunkBody(body: string, maxChars = DEFAULT_MAX_CHARS): string[] {
  const trimmed = body.trim();
  if (!trimmed) return [];

  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if (current && current.length + p.length + 2 > maxChars) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
