import { CachingEmbedder } from './caching-embedder';
import { FakeEmbedder } from './fake-embedder';

describe('CachingEmbedder', () => {
  it('dimensions를 내부 임베더에 위임한다', () => {
    expect(new CachingEmbedder(new FakeEmbedder()).dimensions).toBe(64);
  });

  it('같은 text는 캐시 적중 — 내부 임베더를 재호출하지 않는다', async () => {
    const inner = new FakeEmbedder();
    const spy = jest.spyOn(inner, 'embed');
    const c = new CachingEmbedder(inner);
    const [a] = await c.embed(['hello']);
    const [b] = await c.embed(['hello']);
    expect(a).toEqual(b);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('미스만 위임하고 입력 순서를 보존한다', async () => {
    const inner = new FakeEmbedder();
    const spy = jest.spyOn(inner, 'embed');
    const c = new CachingEmbedder(inner);
    await c.embed(['a']);
    spy.mockClear();
    const out = await c.embed(['a', 'b', 'a', 'c']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(['b', 'c']);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual(out[2]);
  });

  it('max 초과 시 가장 오래된 키를 축출한다', async () => {
    const inner = new FakeEmbedder();
    const spy = jest.spyOn(inner, 'embed');
    const c = new CachingEmbedder(inner, 2);
    await c.embed(['a']);
    await c.embed(['b']);
    await c.embed(['c']); // a 축출
    spy.mockClear();
    await c.embed(['a']); // 재호출(미스)
    expect(spy).toHaveBeenCalledWith(['a']);
  });
});
