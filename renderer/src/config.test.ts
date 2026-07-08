import { describe, it, expect, vi } from 'vitest';

describe('config LANG', () => {
  it('reads ?lang= first, falls back to navigator', async () => {
    vi.stubGlobal('location', { search: '?port=47800&lang=ko' } as any);
    const mod = await import('./config?1');
    expect(mod.LANG).toBe('ko');
  });
});
