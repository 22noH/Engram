// SSE(text/event-stream) 본문에서 `data: <json>` 라인을 순서대로 파싱해 내보낸다.
// '[DONE]'·빈 데이터·비JSON 라인은 건너뛴다(부분 청크 경계는 버퍼로 흡수).
export async function* sseJson(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Record<string, unknown>> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data) as Record<string, unknown>;
      } catch {
        // 비JSON/오염 라인 무시
      }
    }
  }
  // 스트림 종료 후 버퍼에 trailing \n 없는 마지막 data: 라인이 남아있을 수 있다(Finding3) — 디코더 드레인 후 처리.
  buf += decoder.decode();
  const last = buf.trim();
  if (last.startsWith('data:')) {
    const data = last.slice(5).trim();
    if (data && data !== '[DONE]') {
      try {
        yield JSON.parse(data) as Record<string, unknown>;
      } catch {
        // 비JSON/오염 라인 무시
      }
    }
  }
}
