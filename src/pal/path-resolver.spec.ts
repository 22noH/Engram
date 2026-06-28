import * as path from 'path';
import { PathResolver, DEFAULT_USER } from './path-resolver';

describe('PathResolver', () => {
  it('명시적 baseDir를 데이터 디렉토리로 사용한다', () => {
    const r = new PathResolver(path.join('C:', 'tmp', 'engram-test'));
    expect(r.getDataDir()).toBe(path.join('C:', 'tmp', 'engram-test'));
    expect(r.getWikiPagesDir()).toBe(
      path.join('C:', 'tmp', 'engram-test', 'wiki', 'pages', DEFAULT_USER),
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

  it('getWikiPagesDir는 기본 사용자 네임스페이스를 포함한다', () => {
    const r = new PathResolver(path.join('C:', 'data'));
    expect(r.getWikiPagesDir()).toBe(
      path.join('C:', 'data', 'wiki', 'pages', DEFAULT_USER),
    );
  });

  it('getWikiPagesDir는 주어진 userId로 네임스페이스를 만든다', () => {
    const r = new PathResolver(path.join('C:', 'data'));
    expect(r.getWikiPagesDir('alice')).toBe(
      path.join('C:', 'data', 'wiki', 'pages', 'alice'),
    );
  });

  it('getLogsDir는 runtime/logs를 가리킨다', () => {
    const r = new PathResolver(path.join('C:', 'data'));
    expect(r.getLogsDir()).toBe(path.join('C:', 'data', 'logs'));
  });

  it('getConfigDir는 dataDir 아래 config를 반환한다', () => {
    const r = new PathResolver('/data');
    expect(r.getConfigDir()).toBe(require('path').join('/data', 'config'));
  });

  it('getStateDir는 dataDir/state를 가리킨다', () => {
    const r = new PathResolver('/tmp/x');
    expect(r.getStateDir()).toBe(require('path').join('/tmp/x', 'state'));
  });

  it('getProjectsDir는 config/projects 아래를 반환한다', () => {
    const p = new PathResolver('C:/data');
    expect(p.getProjectsDir().replace(/\\/g, '/')).toBe('C:/data/config/projects');
  });

  it('getInsightsDir는 state/insights/{userId} 경로를 준다', () => {
    const r = new PathResolver('/data');
    expect(r.getInsightsDir('default').replace(/\\/g, '/')).toBe('/data/state/insights/default');
  });
});
