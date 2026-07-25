import { BrowserBus } from './browser-bus';
import type { BrowserOp } from '../../../shared/browser-ops';

const NAV: BrowserOp = { kind: 'navigate', url: 'http://localhost:5173' };

describe('BrowserBus — 두뇌 도구 호출 ↔ 화면 왕복', () => {
  it('sender 미설정이면 즉시 실패 텍스트(예외 아님)', async () => {
    const bus = new BrowserBus();
    const r = await bus.request('c1', NAV);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/no chat client/);
  });

  it('전송 실패(받을 클라 없음)도 즉시 실패 텍스트', async () => {
    const bus = new BrowserBus();
    bus.setSender(() => false);
    const r = await bus.request('c1', NAV);
    expect(r.ok).toBe(false);
    expect(bus.pendingCount).toBe(0);
  });

  it('응답이 오면 그대로 돌려준다', async () => {
    const bus = new BrowserBus();
    const seen: Array<{ channelId: string; opId: string; op: BrowserOp }> = [];
    bus.setSender((channelId, opId, op) => { seen.push({ channelId, opId, op }); return true; });
    const p = bus.request('c1', NAV);
    expect(bus.pendingCount).toBe(1);
    bus.settle(seen[0].opId, { ok: true, text: 'moved' });
    await expect(p).resolves.toEqual({ ok: true, text: 'moved' });
    expect(bus.pendingCount).toBe(0);
    expect(seen[0].channelId).toBe('c1');
  });

  it('채널 바인딩: 두 채널이 동시에 열려 있어도 각자 자기 opId로만 풀린다', async () => {
    const bus = new BrowserBus();
    const sent: Array<{ channelId: string; opId: string }> = [];
    bus.setSender((channelId, opId) => { sent.push({ channelId, opId }); return true; });
    const a = bus.request('chan-A', NAV);
    const b = bus.request('chan-B', { kind: 'read' });
    expect(sent.map((s) => s.channelId)).toEqual(['chan-A', 'chan-B']);
    expect(sent[0].opId).not.toBe(sent[1].opId);
    // B가 먼저 답해도 A는 계속 대기한다(섞이지 않는다).
    bus.settle(sent[1].opId, { ok: true, text: 'B says hi' });
    await expect(b).resolves.toEqual({ ok: true, text: 'B says hi' });
    expect(bus.pendingCount).toBe(1);
    bus.settle(sent[0].opId, { ok: true, text: 'A moved' });
    await expect(a).resolves.toEqual({ ok: true, text: 'A moved' });
  });

  it('모르는 opId·중복 응답은 조용히 무시', async () => {
    const bus = new BrowserBus();
    let id = '';
    bus.setSender((_c, opId) => { id = opId; return true; });
    const p = bus.request('c1', NAV);
    bus.settle('nope', { ok: true, text: 'x' });
    bus.settle(id, { ok: true, text: 'first' });
    bus.settle(id, { ok: true, text: 'second' });
    await expect(p).resolves.toEqual({ ok: true, text: 'first' });
  });

  it('응답이 안 오면 타임아웃 실패 텍스트', async () => {
    jest.useFakeTimers();
    try {
      const bus = new BrowserBus(50);
      bus.setSender(() => true);
      const p = bus.request('c1', NAV);
      jest.advanceTimersByTime(60);
      const r = await p;
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(/timed out/);
      expect(bus.pendingCount).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
