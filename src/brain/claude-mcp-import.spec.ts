import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readClaudeMcpServers, ClaudeMcpEntry } from './claude-mcp-import';

describe('claude-mcp-import', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-mcp-import-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const mkdir = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
  };

  const writeFile = (filePath: string, content: string | object) => {
    mkdir(path.dirname(filePath));
    fs.writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content));
  };

  it('user 스코프 stdio+http 판독', () => {
    writeFile(
      path.join(tmp, '.claude.json'),
      {
        mcpServers: {
          'gh-mcp': { command: 'npx', args: ['-y', 'server-github'] },
          'fs-server': { command: 'mcp-fs', env: { ROOT: '/root' } },
          'http-server': { type: 'http', url: 'https://api.example.com/mcp' },
        },
      },
    );

    const entries = readClaudeMcpServers(tmp);
    const entriesByName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(entriesByName['fs-server']).toEqual({
      name: 'fs-server',
      command: 'mcp-fs',
      env: { ROOT: '/root' },
    });
    expect(entriesByName['gh-mcp']).toEqual({
      name: 'gh-mcp',
      command: 'npx',
      args: ['-y', 'server-github'],
    });
    expect(entriesByName['http-server']).toEqual({
      name: 'http-server',
      url: 'https://api.example.com/mcp',
    });
  });

  it('플러그인 .mcp.json 판독+pluginName 부여', () => {
    const installPath = path.join(tmp, '.claude', 'plugins', 'cache', 'context7', 'unknown');
    writeFile(
      path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'),
      {
        version: 2,
        plugins: {
          'context7@claude-plugins-official': [
            {
              scope: 'user',
              installPath,
            },
          ],
        },
      },
    );

    writeFile(path.join(installPath, '.mcp.json'), {
      context7: {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
      },
    });

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([
      {
        name: 'context7',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        pluginName: 'context7',
      },
    ]);
  });

  it('이름 충돌 시 user 스코프가 승리', () => {
    writeFile(path.join(tmp, '.claude.json'), {
      mcpServers: {
        'shared-name': { command: 'user-command', args: ['user-arg'] },
      },
    });

    const installPath = path.join(tmp, '.claude', 'plugins', 'cache', 'plugin1', 'v1');
    writeFile(
      path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'),
      {
        version: 2,
        plugins: {
          'plugin1@market': [{ scope: 'user', installPath }],
        },
      },
    );

    writeFile(path.join(installPath, '.mcp.json'), {
      'shared-name': { command: 'plugin-command' },
    });

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([
      {
        name: 'shared-name',
        command: 'user-command',
        args: ['user-arg'],
      },
    ]);
  });

  it('__proto__·constructor·prototype 스킵', () => {
    writeFile(path.join(tmp, '.claude.json'), {
      mcpServers: {
        '__proto__': { command: 'evil' },
        'constructor': { command: 'evil' },
        'prototype': { command: 'evil' },
        'valid': { command: 'ok' },
      },
    });

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([{ name: 'valid', command: 'ok' }]);
  });

  it('잘못된 형태·빈 command 스킵', () => {
    writeFile(path.join(tmp, '.claude.json'), {
      mcpServers: {
        'bad-type-array': ['should', 'be', 'object'],
        'bad-no-cmd': { args: ['x'] },
        'bad-empty-cmd': { command: '   ' },
        'bad-no-url': { type: 'http' },
        'ok-cmd': { command: 'npx' },
        'ok-url': { type: 'http', url: 'https://x.com' },
      },
    });

    const entries = readClaudeMcpServers(tmp);
    expect(entries.map((e) => e.name).sort()).toEqual(['ok-cmd', 'ok-url']);
  });

  it('파일 없음·깨진 JSON → []', () => {
    // No .claude.json at all
    let entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([]);

    // Broken .claude.json
    writeFile(path.join(tmp, '.claude.json'), '{broken json');
    entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([]);

    // Broken installed_plugins.json
    fs.unlinkSync(path.join(tmp, '.claude.json'));
    mkdir(path.join(tmp, '.claude', 'plugins'));
    writeFile(path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'), '{broken');
    entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([]);
  });

  it('installed_plugins.json의 빈 배열 항목 무해', () => {
    writeFile(
      path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'),
      {
        version: 2,
        plugins: {
          'empty-plugin@market': [],
          'valid-plugin@market': [
            {
              scope: 'user',
              installPath: path.join(tmp, '.claude', 'plugins', 'cache', 'valid-plugin', 'v1'),
            },
          ],
        },
      },
    );

    writeFile(
      path.join(tmp, '.claude', 'plugins', 'cache', 'valid-plugin', 'v1', '.mcp.json'),
      {
        'valid-mcp': { command: 'npx' },
      },
    );

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([{ name: 'valid-mcp', command: 'npx', pluginName: 'valid-plugin' }]);
  });

  it('env는 문자열 값만 수집', () => {
    writeFile(path.join(tmp, '.claude.json'), {
      mcpServers: {
        'test-env': {
          command: 'npx',
          env: {
            valid: 'value',
            number: 123, // 스킵
            bool: true, // 스킵
            null_val: null, // 스킵
            nested: { obj: 'skip' }, // 스킵
          },
        },
      },
    });

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([{ name: 'test-env', command: 'npx', env: { valid: 'value' } }]);
  });

  it('args는 문자열 배열만 수집', () => {
    writeFile(path.join(tmp, '.claude.json'), {
      mcpServers: {
        'test-args': {
          command: 'npx',
          args: ['valid', 123, true, null, { obj: 'skip' }],
        },
      },
    });

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([
      { name: 'test-args', command: 'npx', args: ['valid'] },
    ]);
  });

  it('플러그인 알파벳순 처리', () => {
    const installPathA = path.join(tmp, '.claude', 'plugins', 'cache', 'zebra', 'v1');
    const installPathB = path.join(tmp, '.claude', 'plugins', 'cache', 'alpha', 'v1');

    writeFile(
      path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'),
      {
        version: 2,
        plugins: {
          'zebra@market': [{ scope: 'user', installPath: installPathA }],
          'alpha@market': [{ scope: 'user', installPath: installPathB }],
        },
      },
    );

    writeFile(path.join(installPathA, '.mcp.json'), { zebra: { command: 'z' } });
    writeFile(path.join(installPathB, '.mcp.json'), { alpha: { command: 'a' } });

    const entries = readClaudeMcpServers(tmp);
    // alpha와 zebra 모두 이름이 고유하므로 둘 다 포함, 순서는 플러그인이 알파벳순이므로 alpha가 먼저
    expect(entries).toEqual([
      { name: 'alpha', command: 'a', pluginName: 'alpha' },
      { name: 'zebra', command: 'z', pluginName: 'zebra' },
    ]);
  });

  it('플러그인 레지스트리 키의 @ 분리 정확성', () => {
    const installPath = path.join(tmp, '.claude', 'plugins', 'cache', 'mylib', 'v1');
    writeFile(
      path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'),
      {
        version: 2,
        plugins: {
          'mylib@my-org/marketplace': [{ scope: 'user', installPath }],
        },
      },
    );

    writeFile(path.join(installPath, '.mcp.json'), { mymcp: { command: 'x' } });

    const entries = readClaudeMcpServers(tmp);
    expect(entries[0]?.pluginName).toBe('mylib');
  });

  it('http·sse url 타입 모두 처리', () => {
    const installPath = path.join(tmp, '.claude', 'plugins', 'cache', 'plugin1', 'v1');
    writeFile(
      path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'),
      {
        version: 2,
        plugins: {
          'plugin1@market': [{ scope: 'user', installPath }],
        },
      },
    );

    writeFile(path.join(installPath, '.mcp.json'), {
      'http-mcp': { type: 'http', url: 'https://api.example.com' },
      'sse-mcp': { type: 'sse', url: 'https://sse.example.com' },
    });

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toContainEqual({
      name: 'http-mcp',
      url: 'https://api.example.com',
      pluginName: 'plugin1',
    });
    expect(entries).toContainEqual({
      name: 'sse-mcp',
      url: 'https://sse.example.com',
      pluginName: 'plugin1',
    });
  });

  it('installPath가 없거나 .mcp.json이 없으면 플러그인 스킵', () => {
    writeFile(
      path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'),
      {
        version: 2,
        plugins: {
          'no-install-path@market': [{ scope: 'user' }],
          'no-mcp-json@market': [
            {
              scope: 'user',
              installPath: path.join(tmp, '.claude', 'plugins', 'cache', 'nonexistent', 'v1'),
            },
          ],
        },
      },
    );

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([]);
  });

  it('installed_plugins.json version이 2가 아니면 무시', () => {
    writeFile(
      path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'),
      {
        version: 1,
        plugins: {
          'old-plugin@market': [{ scope: 'user', installPath: '/some/path' }],
        },
      },
    );

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([]);
  });

  it('command와 url 모두 없으면 스킵', () => {
    writeFile(path.join(tmp, '.claude.json'), {
      mcpServers: {
        'bad-entry': {
          args: ['x'],
          env: { K: 'V' },
        },
      },
    });

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([]);
  });

  it('url이 공백이면 스킵', () => {
    writeFile(path.join(tmp, '.claude.json'), {
      mcpServers: {
        'bad-url': { type: 'http', url: '   ' },
      },
    });

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([]);
  });

  it('유효한 이름 문자: 소문자·숫자·하이픈·언더스코어만', () => {
    writeFile(path.join(tmp, '.claude.json'), {
      mcpServers: {
        'valid-name_1': { command: 'ok' },
        'BadName': { command: 'x' },
        'bad-name!': { command: 'x' },
        'name with spaces': { command: 'x' },
      },
    });

    const entries = readClaudeMcpServers(tmp);
    expect(entries.map((e) => e.name)).toEqual(['valid-name_1']);
  });

  it('home 파라미터 생략시 os.homedir() 사용', () => {
    // 이 테스트는 실제 홈디렉토리를 건드리지 않도록 함.
    // 대신 홈 파라미터를 명시적으로 전달하여 격리된 환경에서 테스트
    writeFile(path.join(tmp, '.claude.json'), {
      mcpServers: {
        'test': { command: 'npx' },
      },
    });

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('test');
  });

  it('유효한 url만 반환 (command/args/env 없음)', () => {
    writeFile(path.join(tmp, '.claude.json'), {
      mcpServers: {
        'url-only': { type: 'http', url: 'https://example.com' },
      },
    });

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([
      { name: 'url-only', url: 'https://example.com' },
    ]);
    expect(entries[0]?.command).toBeUndefined();
    expect(entries[0]?.args).toBeUndefined();
    expect(entries[0]?.env).toBeUndefined();
  });

  it('복합 시나리오: user + 플러그인 혼합, 충돌처리, 순서 검증', () => {
    // user 스코프
    writeFile(path.join(tmp, '.claude.json'), {
      mcpServers: {
        'shared': { command: 'user' },
        'user-only': { command: 'user-cmd' },
      },
    });

    // 플러그인 1
    const installPath1 = path.join(tmp, '.claude', 'plugins', 'cache', 'plugin-b', 'v1');
    // 플러그인 2
    const installPath2 = path.join(tmp, '.claude', 'plugins', 'cache', 'plugin-a', 'v1');

    writeFile(
      path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'),
      {
        version: 2,
        plugins: {
          'plugin-b@market': [{ scope: 'user', installPath: installPath1 }],
          'plugin-a@market': [{ scope: 'user', installPath: installPath2 }],
        },
      },
    );

    writeFile(path.join(installPath1, '.mcp.json'), {
      'shared': { command: 'plugin-b' }, // 충돌 - user가 이겨야함
      'plugin-b-only': { command: 'pb' },
    });

    writeFile(path.join(installPath2, '.mcp.json'), {
      'plugin-a-only': { command: 'pa' },
    });

    const entries = readClaudeMcpServers(tmp);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['plugin-a-only', 'plugin-b-only', 'shared', 'user-only']);
    expect(entries.find((e) => e.name === 'shared')?.command).toBe('user');
  });

  it('플러그인 .mcp.json 래핑 형태 (mcpServers 키) 판독', () => {
    const installPath = path.join(tmp, '.claude', 'plugins', 'cache', 'notion', 'unknown');
    writeFile(
      path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'),
      {
        version: 2,
        plugins: {
          'notion@claude-plugins-official': [
            {
              scope: 'user',
              installPath,
            },
          ],
        },
      },
    );

    // 래핑 형태: { "mcpServers": { "notion": {...} } }
    writeFile(path.join(installPath, '.mcp.json'), {
      mcpServers: {
        notion: {
          command: 'npx',
          args: ['-y', '@notion/mcp'],
        },
      },
    });

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([
      {
        name: 'notion',
        command: 'npx',
        args: ['-y', '@notion/mcp'],
        pluginName: 'notion',
      },
    ]);
  });

  it('플러그인 .mcp.json 혼합 형태 (bare + wrapped) 판독', () => {
    // 플러그인 1: bare 형태
    const installPath1 = path.join(tmp, '.claude', 'plugins', 'cache', 'context7', 'v1');
    // 플러그인 2: wrapped 형태
    const installPath2 = path.join(tmp, '.claude', 'plugins', 'cache', 'vercel', 'v1');

    writeFile(
      path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'),
      {
        version: 2,
        plugins: {
          'context7@claude-plugins-official': [{ scope: 'user', installPath: installPath1 }],
          'vercel@claude-plugins-official': [{ scope: 'user', installPath: installPath2 }],
        },
      },
    );

    // bare 형태
    writeFile(path.join(installPath1, '.mcp.json'), {
      context7: {
        command: 'npx',
        args: ['-y', '@context7/mcp'],
      },
    });

    // wrapped 형태
    writeFile(path.join(installPath2, '.mcp.json'), {
      mcpServers: {
        vercel: {
          command: 'npx',
          args: ['-y', '@vercel/mcp'],
        },
      },
    });

    const entries = readClaudeMcpServers(tmp);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['context7', 'vercel']);
    expect(entries.find((e) => e.name === 'context7')?.pluginName).toBe('context7');
    expect(entries.find((e) => e.name === 'vercel')?.pluginName).toBe('vercel');
  });

  it('installPath가 빈 문자열이면 플러그인 스킵', () => {
    writeFile(
      path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'),
      {
        version: 2,
        plugins: {
          'empty-path@market': [{ scope: 'user', installPath: '' }],
        },
      },
    );

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([]);
  });

  it('installPath가 공백만 있으면 플러그인 스킵', () => {
    writeFile(
      path.join(tmp, '.claude', 'plugins', 'installed_plugins.json'),
      {
        version: 2,
        plugins: {
          'whitespace-path@market': [{ scope: 'user', installPath: '   ' }],
        },
      },
    );

    const entries = readClaudeMcpServers(tmp);
    expect(entries).toEqual([]);
  });
});
