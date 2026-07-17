import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeBrainProfile, listBrains, setDefaultBrain } from './brains-file';

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
