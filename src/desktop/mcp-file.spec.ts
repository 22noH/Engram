import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listMcpServersFile, addMcpServer, removeMcpServer } from './mcp-file';

describe('mcp-file', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mcp-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('add: 파일 생성+Claude Code 포맷, argsLine 공백분리, 재로드로 확인', () => {
    expect(addMcpServer(tmp, 'everything', 'npx', '-y @modelcontextprotocol/server-everything')).toBe(true);
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf8'));
    expect(raw.mcpServers.everything).toEqual({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] });
    expect(listMcpServersFile(tmp)).toEqual([{ name: 'everything', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] }]);
  });

  it('add 거부: 이름 규칙 위반·이름 충돌·빈 command → false·무변경', () => {
    expect(addMcpServer(tmp, 'Bad Name', 'x', '')).toBe(false);
    expect(addMcpServer(tmp, 'a', ' ', '')).toBe(false);
    addMcpServer(tmp, 'a', 'x', '');
    expect(addMcpServer(tmp, 'a', 'y', '')).toBe(false);
    expect(listMcpServersFile(tmp)[0].command).toBe('x');
  });

  it('remove 멱등 + 다른 항목·기존 파일 필드 보존', () => {
    fs.writeFileSync(path.join(tmp, 'mcp.json'), JSON.stringify({ somethingElse: 1, mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }));
    removeMcpServer(tmp, 'a');
    removeMcpServer(tmp, 'a');
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf8'));
    expect(raw.mcpServers).toEqual({ b: { command: 'y' } });
    expect(raw.somethingElse).toBe(1);
  });
});
