import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { loadActiveBrain, loadBrainProfile, listBrainNames } from './brain.config';

describe('loadActiveBrain', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cfg-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('파일이 없으면 기본 brains.json을 만들고 default 프로필을 반환한다', () => {
    const p = loadActiveBrain(dir, {});
    expect(p.provider).toBe('claude-cli');
    expect(p.cli).toBe('claude');
    expect(p.concurrency).toBe(2);
    expect(fs.existsSync(path.join(dir, 'brains.json'))).toBe(true);
  });

  it('파일의 default 프로필을 읽는다', () => {
    fs.writeFileSync(
      path.join(dir, 'brains.json'),
      JSON.stringify({ default: 'c', brains: { c: { provider: 'claude-cli', cli: 'claude', model: 'opus', concurrency: 5, timeoutMs: 9000, extraArgs: [] } } }),
    );
    const p = loadActiveBrain(dir, {});
    expect(p.model).toBe('opus');
    expect(p.concurrency).toBe(5);
  });

  it('env가 활성 프로필을 덮어쓴다', () => {
    const p = loadActiveBrain(dir, { ENGRAM_BRAIN_MODEL: 'haiku', ENGRAM_BRAIN_CONCURRENCY: '1' });
    expect(p.model).toBe('haiku');
    expect(p.concurrency).toBe(1);
  });

  it('비숫자·음수·0 concurrency/timeout env는 무시하고 폴백을 유지한다', () => {
    const p = loadActiveBrain(dir, {
      ENGRAM_BRAIN_CONCURRENCY: 'abc',
      ENGRAM_BRAIN_TIMEOUT_MS: '-5',
    });
    expect(p.concurrency).toBe(2); // 기본값 유지(NaN 무력화 방어)
    expect(p.timeoutMs).toBe(300000);
  });

  it('default가 가리키는 프로필이 없으면 throw', () => {
    fs.writeFileSync(path.join(dir, 'brains.json'), JSON.stringify({ default: 'x', brains: {} }));
    expect(() => loadActiveBrain(dir, {})).toThrow(/default/);
  });

  it('claude-cli가 아닌 provider는 거부한다', () => {
    fs.writeFileSync(
      path.join(dir, 'brains.json'),
      JSON.stringify({ default: 'g', brains: { g: { provider: 'gemini-api' } } }),
    );
    expect(() => loadActiveBrain(dir, {})).toThrow(/provider/);
  });
});

describe('loadBrainProfile', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cfg-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('loadBrainProfile은 지정 프로필을 해소한다', () => {
    fs.writeFileSync(path.join(dir, 'brains.json'), JSON.stringify({
      default: 'w', brains: {
        w: { provider: 'claude-cli', model: 'opus' },
        judge: { provider: 'claude-cli', model: 'haiku' },
      },
    }));
    expect(loadBrainProfile(dir, 'judge', {}).model).toBe('haiku');
  });

  it('없는 프로필은 default로 폴백한다', () => {
    fs.writeFileSync(path.join(dir, 'brains.json'), JSON.stringify({
      default: 'w', brains: { w: { provider: 'claude-cli', model: 'opus' } },
    }));
    expect(loadBrainProfile(dir, 'judge', {}).model).toBe('opus'); // judge 없음 → default(w)
  });
});

describe('Phase 8a — engram-api 프로필', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cfg8a-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('anthropic-api provider가 허용되고 신규 필드가 병합된다', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), JSON.stringify({
      default: 'api',
      brains: { api: { provider: 'anthropic-api', apiKey: 'sk-x', maxTokens: 9000, inputUsdPerMTok: 5, outputUsdPerMTok: 25 } },
    }));
    const p = loadActiveBrain(tmp, {});
    expect(p.provider).toBe('anthropic-api');
    expect(p.apiKey).toBe('sk-x');
    expect(p.maxTokens).toBe(9000);
    expect(p.inputUsdPerMTok).toBe(5);
  });

  it('openai-api provider가 허용되고 baseUrl·searchProvider가 병합된다', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), JSON.stringify({
      default: 'ollama',
      brains: { ollama: { provider: 'openai-api', baseUrl: 'http://localhost:11434/v1', model: 'llama3.3', searchProvider: 'brave', searchApiKey: 'bk' } },
    }));
    const p = loadActiveBrain(tmp, {});
    expect(p.provider).toBe('openai-api');
    expect(p.baseUrl).toBe('http://localhost:11434/v1');
    expect(p.searchProvider).toBe('brave');
  });

  it('ENGRAM_BRAIN_API_KEY·ENGRAM_BRAIN_BASE_URL env가 프로필을 덮어쓴다', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), JSON.stringify({
      default: 'api', brains: { api: { provider: 'anthropic-api', apiKey: 'file-key' } },
    }));
    const p = loadActiveBrain(tmp, { ENGRAM_BRAIN_API_KEY: 'env-key', ENGRAM_BRAIN_BASE_URL: 'http://alt' } as NodeJS.ProcessEnv);
    expect(p.apiKey).toBe('env-key');
    expect(p.baseUrl).toBe('http://alt');
  });
});

describe('listBrainNames', () => {
  it('brains.json의 두뇌 이름들을 반환(없으면 [])', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-names-'));
    try {
      fs.writeFileSync(path.join(dir, 'brains.json'), JSON.stringify({ default: 'claude', brains: { claude: {}, ollama: {}, anthropic: {} } }));
      expect(listBrainNames(dir).sort()).toEqual(['anthropic', 'claude', 'ollama']);
      expect(listBrainNames(path.join(dir, 'nope'))).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
