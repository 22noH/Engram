import { applyModelCacheDir } from './transformers-embedder';

describe('applyModelCacheDir', () => {
  it('ENGRAM_MODEL_CACHE_DIR가 있으면 cacheDir를 덮어쓴다', () => {
    const tfEnv: { cacheDir?: string } = { cacheDir: '/원래값' };
    applyModelCacheDir(tfEnv, { ENGRAM_MODEL_CACHE_DIR: 'C:\\data\\models' });
    expect(tfEnv.cacheDir).toBe('C:\\data\\models');
  });

  it('미설정이면 건드리지 않는다(개발 모드 무변경)', () => {
    const tfEnv: { cacheDir?: string } = { cacheDir: '/원래값' };
    applyModelCacheDir(tfEnv, {});
    expect(tfEnv.cacheDir).toBe('/원래값');
  });
});
