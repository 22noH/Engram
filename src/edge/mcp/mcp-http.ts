import type { IncomingMessage, ServerResponse } from 'http';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// 루프백(같은 PC)인지 판정(설계 §3.2 — 루프백 전용 강제). 순수 함수.
// req.socket.remoteAddress에서 나올 수 있는 IPv4/IPv6/IPv4-mapped-IPv6 표기를 모두 허용.
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(remoteAddress: string | undefined): boolean {
  return !!remoteAddress && LOOPBACK_ADDRESSES.has(remoteAddress);
}

// /mcp 요청 1건 처리. SDK StreamableHTTPServerTransport의 stateless 패턴(설치본 v1.29.0
// dist/cjs/examples/server/simpleStatelessStreamableHttp.js 실 예제 확인):
// sessionIdGenerator: undefined로 요청마다 새 transport를 만들어 연결하고 handleRequest에 위임.
// ★POST만 처리(그 예제와 동일 — GET/DELETE는 405). 여기서는 server(Task 1 buildMcpServer 산출물)를
// 호출자가 lazy-singleton으로 재사용하므로(self.adapter가 1회만 build) GET을 허용하면 안 된다:
// GET은 미종료 SSE 스트림(standalone notifications 채널)을 열어 그 transport가 server의 내부
// _transport 참조를 영구 점유 → 다음 POST의 connect()가 전부 "Already connected" 예외로 막힌다
// (실측: 클라 초기화 직후 notifications/initialized가 202를 받으면 백그라운드로 GET SSE를 여는데,
// 이걸 허용하자 이어지는 tools/list POST가 전부 막혀 테스트가 타임아웃했다). POST는 요청 처리가
// 끝나는 즉시(finally) transport를 닫아 server를 다음 요청에 다시 connect 가능하게 되돌린다.
// never-throw: 실패해도 상주를 죽이지 않고 500(또는 405)으로 흡수.
export async function handleMcpRequest(server: Server, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', Allow: 'POST' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      try { await transport.close(); } catch { /* 격리 — 다음 요청은 어차피 새 transport */ }
    }
  } catch (e) {
    if (!res.headersSent) {
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: `internal error: ${e instanceof Error ? e.message : String(e)}` }, id: null }));
      } catch { /* 격리 — 응답조차 못 보내면 포기 */ }
    }
  }
}
