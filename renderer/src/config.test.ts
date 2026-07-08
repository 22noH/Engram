import { describe, it, expect, vi } from 'vitest';

describe('config LANG', () => {
  it('reads ?lang= first, falls back to navigator', async () => {
    vi.stubGlobal('location', { search: '?port=47800&lang=ko' } as any);
    // @ts-expect-error Vitest query parameter for module reload
    const mod = await import('./config?1');
    expect(mod.LANG).toBe('ko');
    expect(mod.ko).toBe(true);
  });

  it('?lang=en drives ko to false regardless of navigator locale', async () => {
    vi.stubGlobal('location', { search: '?port=47800&lang=en' } as any);
    // @ts-expect-error Vitest query parameter for module reload
    const mod = await import('./config?2');
    expect(mod.LANG).toBe('en');
    expect(mod.ko).toBe(false);
  });
});
