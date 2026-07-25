import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadImportConfig } from '../../knowledge-core/import/import.config';
import { readWikiRemoteForm } from '../../knowledge-core/wiki/wiki-remote.config';
import { runSettingsCommand } from '../settings-cli';
import { defaultPlanContext, type PlanContext } from '../settings-registry';
import { buildMcpServer, type McpDeps } from './engram-mcp';
import { ELICIT_OFF_ENV } from './mcp-elicit';
import { makeMcpSettings } from './mcp-settings';

// "AI에게 말로 설정 바꾸기" 경로. 못박는 것:
//  1) 세 경로가 같은 파일을 읽고 쓴다(MCP로 바꾼 값이 터미널 조회에 그대로 보인다)
//  2) 위험 설정은 승인 없이는 안 바뀐다
//  3) elicitation 미지원 클라이언트면 폴백 허용이 아니라 **거부**한다
//  4) 잘못된 감시 폴더는 승인 대화상자조차 뜨지 않고 거부된다

type ElicitHandler = (params: Record<string, unknown>) => unknown;

describe('MCP 설정 도구', () => {
  let data: string;
  let configDir: string;
  let inbox: string;
  let ctx: PlanContext;
  let elicits: Array<Record<string, unknown>>;

  beforeEach(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mcpcfg-'));
    configDir = path.join(data, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mcpcfg-inbox-'));
    ctx = { ...defaultPlanContext(configDir), dataDir: data, homeDir: path.join(data, 'home') };
    elicits = [];
  });
  afterEach(() => {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(inbox, { recursive: true, force: true });
  });

  function deps(withSettings = true): McpDeps {
    return {
      search: jest.fn().mockResolvedValue([]),
      read: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
      propose: jest.fn().mockResolvedValue('p1'),
      askBrain: null,
      brainNames: () => [],
      settings: withSettings ? makeMcpSettings(configDir, ctx) : null,
    };
  }

  // handler=null이면 elicitation 자체를 선언하지 않는 클라이언트(대다수 구형·자동화).
  async function connect(d: McpDeps, handler: ElicitHandler | null = null): Promise<Client> {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(d).connect(serverT);
    const c = handler
      ? new Client({ name: 'cfg-test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } })
      : new Client({ name: 'cfg-test', version: '1.0.0' });
    if (handler) {
      c.setRequestHandler(ElicitRequestSchema, async (req) => {
        elicits.push(req.params as Record<string, unknown>);
        return handler(req.params as Record<string, unknown>) as never;
      });
    }
    await c.connect(clientT);
    return c;
  }

  async function call(c: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const r = (await c.callTool({ name, arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean };
    return { text: r.content.map((x) => x.text ?? '').join('\n'), isError: !!r.isError };
  }

  const approve: ElicitHandler = () => ({ action: 'accept', content: { decision: 'change' } });

  it('settings 미주입이면 도구 자체가 안 뜬다(회귀 0)', async () => {
    const c = await connect(deps(false));
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('engram_config_get');
    expect(names).not.toContain('engram_config_set');
    await c.close();
  });

  it('주입되면 조회·변경 도구 2종 노출', async () => {
    const c = await connect(deps());
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain('engram_config_get');
    expect(names).toContain('engram_config_set');
    const prompts = (await c.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(expect.arrayContaining(['config', 'config-set']));
    await c.close();
  });

  it('조회는 승인 없이 자유(전체·단일·모르는 키)', async () => {
    const c = await connect(deps());
    const all = await call(c, 'engram_config_get', {});
    expect(all.isError).toBe(false);
    expect(all.text).toContain('import.folder');
    expect((await call(c, 'engram_config_get', { key: 'import.mode' })).text).toContain('ai | raw');
    expect((await call(c, 'engram_config_get', { key: 'nope' })).isError).toBe(true);
    expect(elicits).toHaveLength(0);
    await c.close();
  });

  it('안전한 변경(폴더·정리 방식)은 대화상자 없이 바로 적용된다', async () => {
    const c = await connect(deps(), approve);
    expect((await call(c, 'engram_config_set', { key: 'import.folder', value: inbox })).isError).toBe(false);
    await call(c, 'engram_config_set', { key: 'import.enabled', value: 'true' });
    await call(c, 'engram_config_set', { key: 'import.mode', value: 'raw' });
    expect(elicits).toHaveLength(0);
    expect(loadImportConfig(configDir)).toMatchObject({ folder: inbox, enabled: true, mode: 'raw' });
    await c.close();
  });

  // ★단일 출처: MCP가 쓴 값을 터미널 명령이 그대로 본다(파일이 하나이므로).
  it('MCP로 바꾼 값이 터미널 engram config get에 그대로 보인다', async () => {
    const c = await connect(deps());
    await call(c, 'engram_config_set', { key: 'import.folder', value: inbox });
    const cli = runSettingsCommand(['get', 'import.folder'], configDir, ctx);
    expect(cli.output).toContain(inbox);
    // 반대 방향도 — 터미널로 바꾸면 MCP 조회에 보인다.
    runSettingsCommand(['set', 'import.mode', 'raw'], configDir, ctx);
    expect((await call(c, 'engram_config_get', { key: 'import.mode' })).text).toContain('raw');
    await c.close();
  });

  describe('위험한 설정', () => {
    it('위키 git 원격: 승인 대화상자를 거치고, 승인해야 바뀐다', async () => {
      const c = await connect(deps(), approve);
      const r = await call(c, 'engram_config_set', { key: 'wiki.remote', value: 'https://example.com/w.git' });
      expect(r.isError).toBe(false);
      expect(elicits).toHaveLength(1);
      expect(String(elicits[0].message)).toContain('example.com');
      expect(readWikiRemoteForm(configDir).remote).toBe('https://example.com/w.git');
      await c.close();
    });

    it('사용자가 거부하면 아무것도 바뀌지 않는다', async () => {
      const c = await connect(deps(), () => ({ action: 'accept', content: { decision: 'cancel' } }));
      const r = await call(c, 'engram_config_set', { key: 'wiki.remote', value: 'https://example.com/w.git' });
      expect(r.text.toLowerCase()).toContain('declined');
      expect(readWikiRemoteForm(configDir).remote).toBe('');
      await c.close();
    });

    it('대화상자를 닫아도(action:cancel) 바뀌지 않는다', async () => {
      const c = await connect(deps(), () => ({ action: 'cancel' }));
      await call(c, 'engram_config_set', { key: 'import.publish', value: 'direct' });
      expect(loadImportConfig(configDir).publish).toBe('propose');
      await c.close();
    });

    // ★폴백으로 그냥 허용하면 안 된다 — 위키 저장 경로와 정반대의 규칙.
    it('elicitation 미지원 클라이언트면 거부하고 앱/터미널로 안내한다', async () => {
      const c = await connect(deps()); // elicitation 미선언
      const r = await call(c, 'engram_config_set', { key: 'import.publish', value: 'direct' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('refused');
      expect(r.text).toContain("Engram app's settings");
      expect(r.text).toContain('engram config set import.publish direct');
      expect(loadImportConfig(configDir).publish).toBe('propose'); // 파일 그대로
      await c.close();
    });

    it('"바로 게시"는 승인 필요, "승인함으로" 되돌리기는 자유', async () => {
      const c = await connect(deps());
      await call(c, 'engram_config_set', { key: 'import.publish', value: 'direct' }); // 거부됨
      const back = await call(c, 'engram_config_set', { key: 'import.publish', value: 'propose' });
      expect(back.text).toContain('unchanged'); // 애초에 바뀌지 않았으므로
      await c.close();
    });

    it('대화상자를 끈 환경(ENGRAM_MCP_NO_ELICIT)에서도 폴백 허용이 아니라 거부', async () => {
      process.env[ELICIT_OFF_ENV] = '1';
      try {
        const c = await connect(deps(), approve);
        const r = await call(c, 'engram_config_set', { key: 'wiki.remote', value: 'https://example.com/w.git' });
        expect(r.isError).toBe(true);
        expect(elicits).toHaveLength(0);
        expect(readWikiRemoteForm(configDir).remote).toBe('');
        await c.close();
      } finally {
        delete process.env[ELICIT_OFF_ENV];
      }
    });

    it('이미 같은 값이면 대화상자를 띄우지 않는다', async () => {
      const c = await connect(deps(), approve);
      await call(c, 'engram_config_set', { key: 'wiki.remote', value: 'https://example.com/w.git' });
      elicits.length = 0;
      const again = await call(c, 'engram_config_set', { key: 'wiki.remote', value: 'https://example.com/w.git' });
      expect(again.text).toContain('unchanged');
      expect(elicits).toHaveLength(0);
      await c.close();
    });
  });

  describe('경로 검증', () => {
    it('엔그램 데이터 폴더는 승인해도 못 쓴다(대화상자조차 안 뜬다)', async () => {
      const c = await connect(deps(), approve);
      const r = await call(c, 'engram_config_set', { key: 'import.folder', value: data });
      expect(r.isError).toBe(true);
      expect(elicits).toHaveLength(0);
      expect(loadImportConfig(configDir).folder).toBe('');
      await c.close();
    });

    it('시스템 폴더·없는 폴더·상대경로 거부', async () => {
      const c = await connect(deps(), approve);
      const sys = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc';
      expect((await call(c, 'engram_config_set', { key: 'import.folder', value: sys })).isError).toBe(true);
      expect((await call(c, 'engram_config_set', { key: 'import.folder', value: path.join(inbox, 'nope') })).isError).toBe(true);
      expect((await call(c, 'engram_config_set', { key: 'import.folder', value: 'inbox' })).isError).toBe(true);
      expect(elicits).toHaveLength(0);
      expect(loadImportConfig(configDir).folder).toBe('');
      await c.close();
    });

    it('읽기 전용 두뇌 설정은 변경 거부', async () => {
      const c = await connect(deps(), approve);
      const r = await call(c, 'engram_config_set', { key: 'brain.default', value: 'codex' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('read-only');
      await c.close();
    });
  });
});
