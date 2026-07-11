import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadLocalBrains, addLocalBrain } from './local-brains';

describe('local-brains', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('add → load 왕복, 포트는 47801부터 사용중 회피', () => {
    const b1 = addLocalBrain(dir, path.join(dir, 'data'), 'My brain', [47800]);
    expect(b1.port).toBe(47801);
    const b2 = addLocalBrain(dir, path.join(dir, 'data'), 'Second', [47800, 47801]);
    expect(b2.port).toBe(47802);
    const list = loadLocalBrains(dir);
    expect(list.map((b) => b.name)).toEqual(['My brain', 'Second']);
    expect(b1.dataDir).toContain('brains'); // dataRoot/brains/<id>
  });

  it('손상 파일 → 빈 목록', () => {
    fs.writeFileSync(path.join(dir, 'local-brains.json'), 'bad');
    expect(loadLocalBrains(dir)).toEqual([]);
  });
});
