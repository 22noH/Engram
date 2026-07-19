import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { AddressInfo } from 'net';
import { Test } from '@nestjs/testing';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultDataDir, parseHeadlessArgs, chooseMode } from './mcp-headless';
import { HeadlessCoreModule } from './knowledge-core/headless-core.module';
import { RagStore } from './knowledge-core/rag/rag-store';
import { WikiEngine } from './knowledge-core/wiki/wiki-engine';
import { ProposalStore } from './knowledge-core/proposal-store';
import { ProposalApplier } from './edge/proposal-applier';
import { PathResolver } from './pal/path-resolver';
import { buildMcpServer, McpDeps } from './edge/mcp/engram-mcp';
import { makeMcpProposals } from './edge/mcp/mcp-proposals';
import { makeWikiMcpDepsCore } from './edge/mcp/mcp-wiring';
import { McpSession, MCP_TOOL_PREFIX } from './brain/mcp-client';

const T = (bare: string) => `${MCP_TOOL_PREFIX}test__${bare}`;

describe('defaultDataDir', () => {
  it('win32 — %APPDATA%\\Engram', () => {
    expect(defaultDataDir('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' })).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\Engram',
    );
  });

  it('win32 — APPDATA 미설정 시 homedir 기반 폴백(크래시 없이 안전한 기본값)', () => {
    const dir = defaultDataDir('win32', {});
    expect(dir.endsWith('Engram')).toBe(true);
    expect(dir).toContain('AppData');
  });

  it('darwin — ~/Library/Application Support/Engram', () => {
    const dir = defaultDataDir('darwin', {});
    expect(dir.endsWith(require('path').join('Library', 'Application Support', 'Engram'))).toBe(true);
  });

  it('linux(기타) — XDG_CONFIG_HOME/Engram', () => {
    expect(defaultDataDir('linux', { XDG_CONFIG_HOME: '/home/me/.config' })).toBe(
      require('path').join('/home/me/.config', 'Engram'),
    );
  });

  it('linux(기타) — XDG_CONFIG_HOME 미설정 시 ~/.config/Engram', () => {
    const dir = defaultDataDir('linux', {});
    expect(dir.endsWith(require('path').join('.config', 'Engram'))).toBe(true);
  });
});

describe('parseHeadlessArgs', () => {
  const dummyDataDirEnv = { ENGRAM_DATA_DIR: '/tmp/engram-test-data' };

  it('--data-dir 인자가 최우선', () => {
    const { dataDir } = parseHeadlessArgs(['node', 'x.js', '--data-dir', '/custom/dir'], dummyDataDirEnv);
    expect(dataDir).toBe('/custom/dir');
  });

  it('--data-dir 없으면 ENGRAM_DATA_DIR env', () => {
    const { dataDir } = parseHeadlessArgs(['node', 'x.js'], dummyDataDirEnv);
    expect(dataDir).toBe('/tmp/engram-test-data');
  });

  it('둘 다 없으면 OS 기본 데이터 경로', () => {
    const { dataDir } = parseHeadlessArgs(['node', 'x.js'], {});
    expect(dataDir.endsWith('Engram')).toBe(true);
  });

  it('--write-mode 플래그 — 있으면 true, 없으면 false', () => {
    expect(parseHeadlessArgs(['node', 'x.js', '--write-mode'], {}).writeMode).toBe(true);
    expect(parseHeadlessArgs(['node', 'x.js'], {}).writeMode).toBe(false);
  });

  it('--port 인자가 최우선', () => {
    const { port } = parseHeadlessArgs(['node', 'x.js', '--port', '9999'], { ENGRAM_PORT: '8888' });
    expect(port).toBe(9999);
  });

  it('--port 없으면 ENGRAM_PORT env', () => {
    const { port } = parseHeadlessArgs(['node', 'x.js'], { ENGRAM_PORT: '8888' });
    expect(port).toBe(8888);
  });

  it('둘 다 없으면 DEFAULT_CHAT_PORT(47800)', () => {
    const { port } = parseHeadlessArgs(['node', 'x.js'], {});
    expect(port).toBe(47800);
  });

  it('--port 값이 잘못됐으면(비숫자·범위밖) env로 폴백, env도 잘못되면 기본값', () => {
    expect(parseHeadlessArgs(['node', 'x.js', '--port', 'xyz'], { ENGRAM_PORT: '7000' }).port).toBe(7000);
    expect(parseHeadlessArgs(['node', 'x.js'], { ENGRAM_PORT: '-1' }).port).toBe(47800);
  });
});

describe('chooseMode', () => {
  it('GET / 이 200 + {ok:true} 응답 → "bridge"', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await chooseMode(port)).toBe('bridge');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('연결 거부(듣는 곳 없음) → "core"', async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    // attempts:1 — 단발 프로브 분류만 검증(재시도 루프 자체는 아래 별도 describe).
    expect(await chooseMode(port, 2000, { attempts: 1 })).toBe('core');
  });

  it('200이지만 {ok:true}가 아닌 응답 → "core"(다른 서비스가 그 포트를 쓰고 있을 가능성)', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ not: 'engram' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await chooseMode(port, 2000, { attempts: 1 })).toBe('core');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('200 + 비JSON 본문 → "core"(never-throw)', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not json');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await chooseMode(port, 2000, { attempts: 1 })).toBe('core');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('행(hung) 서버 — 접속은 받되 영원히 무응답 → 타임아웃 후 "core"(멈춘 상주에 안 매달림)', async () => {
    // 요청 핸들러가 아무것도 안 함 = 응답을 영원히 안 보내는 서버(8a 교훈의 "스톨" 클래스).
    const server = http.createServer(() => { /* never respond */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // 테스트 속도를 위해 짧은 타임아웃 + attempts:1 — 프로덕션 기본값(2000ms)과 같은 코드 경로.
      expect(await chooseMode(port, 300, { attempts: 1 })).toBe('core');
    } finally {
      // 행 중인 소켓이 close를 막지 않게 강제 정리.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe('재시도 루프(★2026-07-19 실사고 — 앱이 막 부팅 중이면 바로 core로 폴백하지 않고 기다린다)', () => {
    it('첫 시도가 성공하면 즉시 bridge — 빠른 경로 보존(대기 없음)', async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        // attempts 기본값(6)을 그대로 둬도 1회차 성공이면 대기 없이 바로 반환됨을 검증.
        const start = Date.now();
        expect(await chooseMode(port, 2000)).toBe('bridge');
        expect(Date.now() - start).toBeLessThan(1000);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('3번째 시도에서 앱이 응답하면 bridge(앱이 그 사이 부팅을 마친 상황을 흉내)', async () => {
      let attempt = 0;
      const server = http.createServer((req, res) => {
        attempt++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: attempt >= 3 }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        // intervalMs를 짧게 줘 테스트 속도 확보 — 재시도 루프 로직 자체는 프로덕션과 동일.
        const mode = await chooseMode(port, 2000, { attempts: 6, intervalMs: 5 });
        expect(mode).toBe('bridge');
        expect(attempt).toBe(3);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('끝까지 응답이 없으면 attempts회를 다 재시도한 뒤에야 "core"', async () => {
      let attempt = 0;
      const server = http.createServer((req, res) => {
        attempt++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false })); // 앱이 끝까지 안 뜨는 상황 흉내(항상 core)
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        const mode = await chooseMode(port, 2000, { attempts: 6, intervalMs: 5 });
        expect(mode).toBe('core');
        expect(attempt).toBe(6);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});

// 근본픽스(2026-07-20): core 모드 배선(runCore가 조립하는 것과 동일한 조합 — HeadlessCoreModule +
// makeWikiMcpDepsCore + buildMcpServer)을 실제 MCP 왕복으로 검증한다. RagStore는 HeadlessCoreModule
// 그래프에 없으므로(headless-core.module.spec.ts가 DI 레벨로 이미 증명) 여기선 "그 배선으로 쌓은
// 서버가 실제로 기대대로 동작하는지"(텍스트 폴백 검색 결과·다른 도구 무변경)에 집중한다.
describe('core 모드 MCP 배선(HeadlessCoreModule 근본픽스)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-headless-core-mcp-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('RagStore는 이 조합에서 인스턴스화되지 않는다(DI 조회 실패로 증명)', async () => {
    const app = await Test.createTestingModule({ imports: [HeadlessCoreModule] })
      .overrideProvider(PathResolver).useValue(new PathResolver(dir))
      .compile();
    await app.init();
    expect(() => app.get(RagStore, { strict: false })).toThrow();
    await app.close();
  });

  it('wiki_search MCP 왕복: 도구 설명에 오프라인 안내 + 결과는 텍스트 매치', async () => {
    const app = await Test.createTestingModule({ imports: [HeadlessCoreModule] })
      .overrideProvider(PathResolver).useValue(new PathResolver(dir))
      .compile();
    await app.init();
    const wiki = app.get(WikiEngine);
    const proposals = app.get(ProposalStore);
    await wiki.createPage({
      slug: 'rust-tips', title: 'Rust 학습 팁', category: 'c',
      body: '오너십과 대여를 먼저 익혀라.', status: 'published',
    });
    await wiki.createPage({
      slug: 'cooking', title: '파스타 레시피', category: 'c',
      body: '마늘과 올리브오일로 알리오 올리오를 만든다.', status: 'published',
    });

    const applier = new ProposalApplier(wiki, proposals);
    const deps: McpDeps = {
      ...makeWikiMcpDepsCore(wiki, proposals),
      askBrain: null,
      brainNames: () => [],
      proposals: makeMcpProposals(proposals, applier),
      write: null,
    };

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(deps).connect(serverT);
    const s = McpSession.createForTest('test', clientT);
    await s.connect();

    const defs = await s.listToolDefs();
    const wikiSearchDef = defs.find((d) => d.name === T('wiki_search'));
    expect(wikiSearchDef?.description).toContain('offline');

    const out = await s.callTool(T('wiki_search'), { query: 'Rust' });
    expect(out).toContain('rust-tips');
    expect(out).not.toContain('cooking');

    await s.close();
    await app.close();
  });

  it('wiki_read/wiki_list/wiki_propose: core 모드에서도 기존과 동일하게 동작(회귀 없음)', async () => {
    const app = await Test.createTestingModule({ imports: [HeadlessCoreModule] })
      .overrideProvider(PathResolver).useValue(new PathResolver(dir))
      .compile();
    await app.init();
    const wiki = app.get(WikiEngine);
    const proposals = app.get(ProposalStore);
    await wiki.createPage({
      slug: 'p1', title: 'Page One', category: 'c', body: 'body one', status: 'published',
    });

    const applier = new ProposalApplier(wiki, proposals);
    const deps: McpDeps = {
      ...makeWikiMcpDepsCore(wiki, proposals),
      askBrain: null,
      brainNames: () => [],
      proposals: makeMcpProposals(proposals, applier),
      write: null,
    };

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(deps).connect(serverT);
    const s = McpSession.createForTest('test', clientT);
    await s.connect();

    const readOut = await s.callTool(T('wiki_read'), { slug: 'p1' });
    expect(readOut).toContain('body one');

    const listOut = await s.callTool(T('wiki_list'), {});
    expect(listOut).toContain('p1');

    const proposeOut = await s.callTool(T('wiki_propose'), { title: 'New', content: 'new body' });
    expect(proposeOut).toMatch(/proposal .+ created/);
    const pending = await proposals.listPending();
    expect(pending).toHaveLength(1);

    await s.close();
    await app.close();
  });
});
