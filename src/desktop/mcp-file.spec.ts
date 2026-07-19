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

  it('list: source=claude 항목·command 없는 url형도 포함', () => {
    fs.writeFileSync(path.join(tmp, 'mcp.json'), JSON.stringify({
      mcpServers: {
        manual: { command: 'usercmd' },
        synced: { command: 'npx', args: ['-y', 'x'], env: { A: '1' }, source: 'claude' },
        remote: { url: 'https://example.com/mcp', source: 'claude' },
      },
    }));
    expect(listMcpServersFile(tmp)).toEqual([
      { name: 'manual', command: 'usercmd' },
      { name: 'synced', command: 'npx', args: ['-y', 'x'], source: 'claude' },
      { name: 'remote', url: 'https://example.com/mcp', source: 'claude' },
    ]);
  });

  it('remove 멱등 + 다른 항목·기존 파일 필드 보존', () => {
    fs.writeFileSync(path.join(tmp, 'mcp.json'), JSON.stringify({ somethingElse: 1, mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }));
    removeMcpServer(tmp, 'a');
    removeMcpServer(tmp, 'a');
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf8'));
    expect(raw.mcpServers).toEqual({ b: { command: 'y' } });
    expect(raw.somethingElse).toBe(1);
  });

  it('remove: source=claude 항목 삭제 거부(읽기 전용) + 수동 항목 삭제는 정상 동작', () => {
    fs.writeFileSync(path.join(tmp, 'mcp.json'), JSON.stringify({
      mcpServers: {
        manual: { command: 'usercmd' },
        synced: { command: 'npx', args: ['-y', 'x'], source: 'claude' },
      },
    }));

    // source=claude 항목 삭제 시도 → 파일 무변경
    removeMcpServer(tmp, 'synced');
    let raw = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf8'));
    expect(raw.mcpServers).toEqual({
      manual: { command: 'usercmd' },
      synced: { command: 'npx', args: ['-y', 'x'], source: 'claude' },
    });

    // 수동 항목 삭제 → 정상 동작 (회귀 테스트)
    removeMcpServer(tmp, 'manual');
    raw = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf8'));
    expect(raw.mcpServers).toEqual({
      synced: { command: 'npx', args: ['-y', 'x'], source: 'claude' },
    });
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

    it('무변경: entries=[] 및 mcp.json 없음 → 파일 생성 안 함', () => {
      mirrorClaudeMcp(tmp, []);
      const file = path.join(tmp, 'mcp.json');
      expect(fs.existsSync(file)).toBe(false);
    });

    it('무변경: entries=[] 및 수동 항목만 → 파일 내용·mtime 무변경', () => {
      const file = path.join(tmp, 'mcp.json');
      const content = JSON.stringify({
        mcpServers: { manual: { command: 'usercmd' } },
      });
      fs.writeFileSync(file, content);
      const statBefore = fs.statSync(file);
      const contentBefore = fs.readFileSync(file, 'utf8');

      // 약간의 지연(mtime 변경 감지 보장)
      const delay = new Promise(resolve => setTimeout(resolve, 10));
      delay.then(() => {
        mirrorClaudeMcp(tmp, []);
        const statAfter = fs.statSync(file);
        const contentAfter = fs.readFileSync(file, 'utf8');

        expect(contentAfter).toBe(contentBefore);
        expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
      });

      return delay;
    });

    it('변경: entries=[] 이지만 stale source=claude 항목 → 제거 후 저장', () => {
      const file = path.join(tmp, 'mcp.json');
      fs.writeFileSync(file, JSON.stringify({
        mcpServers: {
          manual: { command: 'usercmd' },
          stale: { command: 'old-claude', source: 'claude' },
        },
      }));

      mirrorClaudeMcp(tmp, []);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(raw.mcpServers).toEqual({ manual: { command: 'usercmd' } });
    });
  });
});
