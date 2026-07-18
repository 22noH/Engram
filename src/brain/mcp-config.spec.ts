import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadMcpServers, isValidMcpName } from './mcp-config';

describe('mcp-config', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mcp-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const write = (v: unknown) => fs.writeFileSync(path.join(tmp, 'mcp.json'), typeof v === 'string' ? v : JSON.stringify(v));

  it('Claude Code 포맷 파싱: args/env 기본값 채움', () => {
    write({ mcpServers: { gh: { command: 'npx', args: ['-y', 'server-github'] }, fs: { command: 'mcp-fs', env: { ROOT: 'C:\\x' } } } });
    expect(loadMcpServers(tmp)).toEqual({
      gh: { command: 'npx', args: ['-y', 'server-github'], env: {} },
      fs: { command: 'mcp-fs', args: [], env: { ROOT: 'C:\\x' } },
    });
  });
  it('없음/깨짐/형태오류 → {}', () => {
    expect(loadMcpServers(tmp)).toEqual({});
    write('{깨진');
    expect(loadMcpServers(tmp)).toEqual({});
    write({ mcpServers: ['not', 'object'] });
    expect(loadMcpServers(tmp)).toEqual({});
  });
  it('불량 항목 skip: command 없음·빈 문자열·이름 규칙 위반', () => {
    write({ mcpServers: { ok: { command: 'x' }, noCmd: {}, empty: { command: ' ' }, 'Bad Name!': { command: 'y' }, '__proto__': { command: 'z' } } });
    expect(Object.keys(loadMcpServers(tmp))).toEqual(['ok']);
  });
  it('isValidMcpName', () => {
    expect(isValidMcpName('github-mcp_1')).toBe(true);
    expect(isValidMcpName('Bad Name')).toBe(false);
    expect(isValidMcpName('한글')).toBe(false);
    expect(isValidMcpName('')).toBe(false);
  });
});
