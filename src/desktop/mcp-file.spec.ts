import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listMcpServersFile, addMcpServer, removeMcpServer, mirrorClaudeMcp } from './mcp-file';
import type { ClaudeMcpEntry } from '../brain/claude-mcp-import';

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

  describe('mirrorClaudeMcp', () => {
    it('삽입: stdio·http 둘 다 source:claude 표시로 병합', () => {
      const entries: ClaudeMcpEntry[] = [
        { name: 'gh', command: 'npx', args: ['-y', 'server-github'], env: { TOKEN: 'x' } },
        { name: 'remote', url: 'https://example.com/mcp' },
      ];
      mirrorClaudeMcp(tmp, entries);
      const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf8'));
      expect(raw.mcpServers).toEqual({
        gh: { command: 'npx', args: ['-y', 'server-github'], env: { TOKEN: 'x' }, source: 'claude' },
        remote: { url: 'https://example.com/mcp', source: 'claude' },
      });
    });

    it('재실행 시 클로드에서 지운 항목 제거·수동 항목 보존', () => {
      fs.writeFileSync(path.join(tmp, 'mcp.json'), JSON.stringify({
        mcpServers: {
          manual: { command: 'usercmd' }, // source 없음 = 수동
          a: { command: 'old-a', args: [], env: {}, source: 'claude' },
          b: { command: 'old-b', args: [], env: {}, source: 'claude' },
        },
      }));
      mirrorClaudeMcp(tmp, [{ name: 'a', command: 'new-a' }]); // b는 클로드에서 지워진 상태
      const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf8'));
      expect(raw.mcpServers).toEqual({
        manual: { command: 'usercmd' },
        a: { command: 'new-a', args: [], env: {}, source: 'claude' },
      });
    });

    it('이름 충돌=수동 승리(스킵)+console.warn', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      fs.writeFileSync(path.join(tmp, 'mcp.json'), JSON.stringify({
        mcpServers: { foo: { command: 'usercmd' } }, // source 없음 = 수동
      }));
      mirrorClaudeMcp(tmp, [{ name: 'foo', command: 'claudecmd' }]);
      const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf8'));
      expect(raw.mcpServers).toEqual({ foo: { command: 'usercmd' } });
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('mcp.json 없음 = 생성', () => {
      mirrorClaudeMcp(tmp, [{ name: 'a', command: 'x' }]);
      const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf8'));
      expect(raw.mcpServers).toEqual({ a: { command: 'x', args: [], env: {}, source: 'claude' } });
    });
  });
});
