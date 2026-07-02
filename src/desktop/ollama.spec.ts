import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectOllama, addOllamaProfile } from './ollama';

describe('detectOllama', () => {
  it('응답 OK면 running + 모델 이름 목록', async () => {
    const fetchFn = (async () => ({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3.3:latest' }, { name: 'qwen3:8b' }] }),
    })) as unknown as typeof fetch;
    expect(await detectOllama(fetchFn)).toEqual({ running: true, models: ['llama3.3:latest', 'qwen3:8b'] });
  });

  it('연결 실패(throw)면 running=false', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await detectOllama(fetchFn)).toEqual({ running: false, models: [] });
  });

  it('비정상 응답(ok=false)도 running=false', async () => {
    const fetchFn = (async () => ({ ok: false })) as unknown as typeof fetch;
    expect(await detectOllama(fetchFn)).toEqual({ running: false, models: [] });
  });
});

describe('addOllamaProfile', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ollama-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function readBrains(): any {
    return JSON.parse(fs.readFileSync(path.join(tmp, 'brains.json'), 'utf8'));
  }

  it('brains.json이 없으면 만들고 ollama 프로필을 넣는다(default는 claude 유지)', () => {
    addOllamaProfile(tmp, 'llama3.3:latest');
    const cfg = readBrains();
    expect(cfg.brains.ollama).toEqual({
      provider: 'claude-cli',
      cli: 'claude',
      model: 'llama3.3:latest',
      env: { ANTHROPIC_BASE_URL: 'http://localhost:11434' },
    });
    expect(cfg.default).toBe('claude');
  });

  it('기존 프로필을 보존하고 ollama만 병합한다', () => {
    fs.writeFileSync(
      path.join(tmp, 'brains.json'),
      JSON.stringify({ default: 'claude', brains: { claude: { model: 'opus' }, judge: {} } }),
    );
    addOllamaProfile(tmp, 'qwen3:8b');
    const cfg = readBrains();
    expect(cfg.brains.claude).toEqual({ model: 'opus' });
    expect(cfg.brains.judge).toEqual({});
    expect(cfg.brains.ollama.model).toBe('qwen3:8b');
  });

  it('setDefault=true면 default를 ollama로 바꾼다', () => {
    addOllamaProfile(tmp, 'qwen3:8b', true);
    expect(readBrains().default).toBe('ollama');
  });

  it('깨진 brains.json이면 기본 골격으로 재작성(fault-tolerant)', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), '{깨진 JSON');
    addOllamaProfile(tmp, 'qwen3:8b');
    expect(readBrains().brains.ollama.model).toBe('qwen3:8b');
  });
});
