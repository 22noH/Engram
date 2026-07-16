import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { saveAnthropicApiKey } from './api-brain';

describe('saveAnthropicApiKey', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ak-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('anthropic 프로필을 쓰고 기본은 유지', () => {
    saveAnthropicApiKey(tmp, 'sk-ant-x');
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'brains.json'), 'utf8'));
    expect(cfg.brains.anthropic).toEqual({ provider: 'anthropic-api', model: 'claude-opus-4-8', apiKey: 'sk-ant-x' });
    expect(cfg.default).toBe('claude');
  });

  it('setDefault=true면 default를 anthropic으로', () => {
    saveAnthropicApiKey(tmp, 'sk-ant-x', true);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'brains.json'), 'utf8'));
    expect(cfg.default).toBe('anthropic');
  });
});
