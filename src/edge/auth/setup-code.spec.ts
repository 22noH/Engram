import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureSetupCode, readSetupCode, clearSetupCode } from './setup-code';

describe('setup-code', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('ensure는 멱등(두 번 불러도 같은 코드), read/clear', () => {
    const c1 = ensureSetupCode(dir);
    expect(c1).toMatch(/^[0-9a-f]{32}$/);
    expect(ensureSetupCode(dir)).toBe(c1);
    expect(readSetupCode(dir)).toBe(c1);
    clearSetupCode(dir);
    expect(readSetupCode(dir)).toBeNull();
  });
});
