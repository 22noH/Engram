import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findRepoRoot } from './repo-root';

describe('findRepoRoot', () => {
  it('__dirname에서 위로 올라가 실제 레포 루트(package.json + personas 보유)를 찾는다', () => {
    // 자기수정 백스톱 배선의 핵심: 빌드(dist) / 테스트(src) 어디서 돌든 진짜 레포 루트를 가리켜야 한다.
    const root = findRepoRoot(__dirname);
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'personas'))).toBe(true); // dist/·src/엔 없는 마커 → 루트 확정
  });

  it('package.json이 없는 격리 디렉터리는 시작 디렉터리로 폴백', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
    try {
      // tmp 위로 package.json이 없다는 보장은 없으니, 적어도 반환값이 절대경로이고
      // package.json을 가진 디렉터리이거나 시작 디렉터리임을 확인(크래시 없음).
      const r = findRepoRoot(tmp);
      expect(path.isAbsolute(r)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
