import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeBrainProfile, listBrains, setDefaultBrain, slugFromModel, removeBrainProfile, listBrainDetails, updateBrainProfile } from './brains-file';

describe('mergeBrainProfile', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-bf-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const read = () => JSON.parse(fs.readFileSync(path.join(tmp, 'brains.json'), 'utf8'));

  it('없으면 만들고 프로필 병합(default=claude 유지)', () => {
    mergeBrainProfile(tmp, 'x', { provider: 'openai-api' });
    expect(read()).toEqual({ default: 'claude', brains: { x: { provider: 'openai-api' } } });
  });

  it('기존 프로필 보존 + setDefault 시 default 교체', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), JSON.stringify({ default: 'claude', brains: { claude: { model: 'opus' } } }));
    mergeBrainProfile(tmp, 'api', { provider: 'anthropic-api' }, true);
    const cfg = read();
    expect(cfg.brains.claude).toEqual({ model: 'opus' });
    expect(cfg.default).toBe('api');
  });

  it("이름이 '__proto__'여도 조용히 유실되지 않고 own property로 저장", () => {
    mergeBrainProfile(tmp, '__proto__', { provider: 'openai-api' });
    expect(read().brains['__proto__']).toEqual({ provider: 'openai-api' });
  });

  it('깨진 파일은 기본 골격으로 재작성', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), '{{{');
    mergeBrainProfile(tmp, 'x', { provider: 'openai-api' });
    expect(read().brains.x.provider).toBe('openai-api');
  });

  it('유효 JSON이지만 brains/default 형태가 틀리면(배열·숫자 등) 기본 골격으로 재작성(Finding4)', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), JSON.stringify({ default: 42, brains: ['not', 'an', 'object'] }));
    mergeBrainProfile(tmp, 'x', { provider: 'openai-api' });
    const cfg = read();
    expect(cfg).toEqual({ default: 'claude', brains: { x: { provider: 'openai-api' } } });
  });

  it('brains가 문자열이어도 기본 골격으로 재작성(Finding4)', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), JSON.stringify({ default: 'claude', brains: 'oops' }));
    mergeBrainProfile(tmp, 'x', { provider: 'openai-api' });
    expect(read().brains).toEqual({ x: { provider: 'openai-api' } });
  });
});

describe('listBrains / setDefaultBrain', () => {
  it('두뇌 목록과 기본여부 반환', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-lb-'));
    try {
      fs.writeFileSync(path.join(dir, 'brains.json'), JSON.stringify({
        default: 'anthropic',
        brains: { claude: { provider: 'claude-cli', model: '' }, anthropic: { provider: 'anthropic-api', model: 'claude-opus-4-8' } },
      }));
      const list = listBrains(dir);
      expect(list.find((b) => b.key === 'anthropic')).toEqual({ key: 'anthropic', provider: 'anthropic-api', model: 'claude-opus-4-8', isDefault: true });
      expect(list.find((b) => b.key === 'claude')!.isDefault).toBe(false);
      expect(listBrains(path.join(dir, 'none'))).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('setDefaultBrain은 default만 바꾸고 나머지 보존', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-sd-'));
    try {
      fs.writeFileSync(path.join(dir, 'brains.json'), JSON.stringify({ default: 'claude', brains: { claude: {}, anthropic: {} } }));
      setDefaultBrain(dir, 'anthropic');
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'brains.json'), 'utf8'));
      expect(raw.default).toBe('anthropic');
      expect(Object.keys(raw.brains).sort()).toEqual(['anthropic', 'claude']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('slugFromModel', () => {
  it('콜론을 -로: qwen3:8b → qwen3-8b', () => {
    expect(slugFromModel('qwen3:8b')).toBe('qwen3-8b');
  });
  it('슬래시·점 등 영숫자 외 문자 전부 -로, 소문자화, 연속 - 축약', () => {
    expect(slugFromModel('hf.co/Org/Model.Q4_K_M')).toBe('hf-co-org-model-q4_k_m');
  });
  it('양끝 - 제거', () => {
    expect(slugFromModel(':qwen:')).toBe('qwen');
  });
  it('빈 결과면 ollama 폴백', () => {
    expect(slugFromModel('::')).toBe('ollama');
    expect(slugFromModel('')).toBe('ollama');
  });
});

describe('removeBrainProfile', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-brains-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const file = () => path.join(tmp, 'brains.json');
  const read = () => JSON.parse(fs.readFileSync(file(), 'utf8'));

  it('기본이 아닌 프로필을 지운다(나머지 보존)', () => {
    fs.writeFileSync(file(), JSON.stringify({ default: 'claude', brains: { claude: {}, gemma: { model: 'gemma4:e4b' } } }));
    removeBrainProfile(tmp, 'gemma');
    expect(read()).toEqual({ default: 'claude', brains: { claude: {} } });
  });
  it('default 프로필이면 no-op(서버 기동 안전선)', () => {
    fs.writeFileSync(file(), JSON.stringify({ default: 'claude', brains: { claude: {}, gemma: {} } }));
    removeBrainProfile(tmp, 'claude');
    expect(read().brains.claude).toEqual({});
  });
  it('없는 key·파일 없음·깨진 파일 전부 no-op', () => {
    expect(() => removeBrainProfile(tmp, 'ghost')).not.toThrow();
    fs.writeFileSync(file(), JSON.stringify({ default: 'claude', brains: { claude: {} } }));
    removeBrainProfile(tmp, 'ghost');
    expect(read().brains.claude).toEqual({});
    fs.writeFileSync(file(), '{깨진');
    expect(() => removeBrainProfile(tmp, 'claude')).not.toThrow();
    expect(fs.readFileSync(file(), 'utf8')).toBe('{깨진');
  });
});

describe('listBrainDetails', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-bd-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('전 필드 + hasApiKey(원문 미포함) + isDefault', () => {
    fs.writeFileSync(path.join(tmp, 'brains.json'), JSON.stringify({
      default: 'q',
      brains: { q: { provider: 'openai-api', model: 'qwen3:8b', baseUrl: 'http://x/v1', apiKey: 'sk-secret', maxTokens: 8000, inputUsdPerMTok: 1, searchProvider: 'brave', searchApiKey: 'bk' } },
    }));
    const [d] = listBrainDetails(tmp);
    expect(d).toEqual({
      key: 'q', provider: 'openai-api', model: 'qwen3:8b', baseUrl: 'http://x/v1',
      maxTokens: 8000, inputUsdPerMTok: 1, outputUsdPerMTok: null,
      searchProvider: 'brave', hasApiKey: true, hasSearchApiKey: true, isDefault: true,
    });
    expect(JSON.stringify(listBrainDetails(tmp))).not.toContain('sk-secret');
  });
  it('없는/깨진 파일 → []', () => {
    expect(listBrainDetails(tmp)).toEqual([]);
    fs.writeFileSync(path.join(tmp, 'brains.json'), '{깨진');
    expect(listBrainDetails(tmp)).toEqual([]);
  });
});

describe('updateBrainProfile', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-up-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const file = () => path.join(tmp, 'brains.json');
  const read = () => JSON.parse(fs.readFileSync(file(), 'utf8'));
  const seed = () => fs.writeFileSync(file(), JSON.stringify({
    default: 'q', brains: { q: { provider: 'openai-api', model: 'qwen3:8b', apiKey: 'OLD' }, c: { provider: 'claude-cli' } },
  }));

  it('부분 갱신: 정의된 필드만, apiKey 빈문자열은 기존 보존', () => {
    seed();
    expect(updateBrainProfile(tmp, 'q', { model: 'qwen3:14b', apiKey: '', maxTokens: 9000 })).toBe(true);
    const b = read().brains.q;
    expect(b).toEqual({ provider: 'openai-api', model: 'qwen3:14b', apiKey: 'OLD', maxTokens: 9000 });
  });
  it('apiKey 새 값은 교체, 숫자 null은 필드 제거, 문자열 빈값은 필드 제거', () => {
    seed();
    fs.writeFileSync(file(), JSON.stringify({ default: 'q', brains: { q: { model: 'm', baseUrl: 'http://x', apiKey: 'OLD', maxTokens: 1 } } }));
    updateBrainProfile(tmp, 'q', { apiKey: 'NEW', maxTokens: null, baseUrl: '' });
    expect(read().brains.q).toEqual({ model: 'm', apiKey: 'NEW' });
  });
  it('숫자 비정상(0·음수·NaN)은 무시(기존 유지)', () => {
    seed();
    updateBrainProfile(tmp, 'q', { maxTokens: -5 });
    expect(read().brains.q.maxTokens).toBeUndefined();
    fs.writeFileSync(file(), JSON.stringify({ default: 'q', brains: { q: { maxTokens: 7 } } }));
    updateBrainProfile(tmp, 'q', { maxTokens: Number.NaN });
    expect(read().brains.q.maxTokens).toBe(7);
  });
  it('이름변경: 이동+default 포인터 이동, 새 이름 충돌은 false(무변경)', () => {
    seed();
    expect(updateBrainProfile(tmp, 'q', {}, 'qwen')).toBe(true);
    const cfg = read();
    expect(cfg.brains.qwen.model).toBe('qwen3:8b');
    expect(cfg.brains.q).toBeUndefined();
    expect(cfg.default).toBe('qwen');
    expect(updateBrainProfile(tmp, 'qwen', {}, 'c')).toBe(false);
    expect(read().brains.qwen.model).toBe('qwen3:8b');
  });
  it("key '__proto__'는 프로토타입 오염 없이 false (own property 아님)", () => {
    seed();
    expect(updateBrainProfile(tmp, '__proto__', { model: 'PWNED' })).toBe(false);
    expect(({} as Record<string, unknown>).model).toBeUndefined();
    expect(read().brains.q.model).toBe('qwen3:8b');
  });
  it("이름변경 newKey 'toString'은 상속 프로퍼티와 충돌로 오인하지 않는다", () => {
    seed();
    expect(updateBrainProfile(tmp, 'q', {}, 'toString')).toBe(true);
    expect(read().brains.toString.model).toBe('qwen3:8b');
    expect(read().default).toBe('toString');
  });
  it('없는 key·없는/깨진 파일 → false·무변경', () => {
    expect(updateBrainProfile(tmp, 'ghost', {})).toBe(false);
    fs.writeFileSync(file(), '{깨진');
    expect(updateBrainProfile(tmp, 'q', {})).toBe(false);
    expect(fs.readFileSync(file(), 'utf8')).toBe('{깨진');
  });
});
