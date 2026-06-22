import * as path from 'path';
import { PathResolver } from './path-resolver';

describe('PathResolver', () => {
  it('명시적 baseDir를 데이터 디렉토리로 사용한다', () => {
    const r = new PathResolver(path.join('C:', 'tmp', 'engram-test'));
    expect(r.getDataDir()).toBe(path.join('C:', 'tmp', 'engram-test'));
    expect(r.getWikiPagesDir()).toBe(
      path.join('C:', 'tmp', 'engram-test', 'wiki', 'pages'),
    );
  });

  it('baseDir 미지정 시 cwd/runtime을 기본값으로 쓴다', () => {
    delete process.env.ENGRAM_DATA_DIR;
    const r = new PathResolver();
    expect(r.getDataDir()).toBe(path.join(process.cwd(), 'runtime'));
  });

  it('getRagDir는 dataDir 아래 rag 경로를 반환한다', () => {
    const paths = new PathResolver(path.join('C:', 'tmp', 'engram-test'));
    expect(paths.getRagDir()).toBe(path.join('C:', 'tmp', 'engram-test', 'rag'));
  });
});
