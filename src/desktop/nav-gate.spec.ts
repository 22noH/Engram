import { EventEmitter } from 'events';
import { attachNavGate } from './nav-gate';

// 1단계에서 남은 구멍: 페이지 **안에서** 링크를 눌러 나가는 이동은 허용 목록 게이트를 안 탔다.
// 메인 프로세스가 막고, 막았으면 반드시 알린다.

function harness(sites: string[] = []) {
  const contents = new EventEmitter();
  const blocked: string[] = [];
  attachNavGate(contents as never, () => sites, (url) => blocked.push(url));
  const go = (event: 'will-navigate' | 'will-redirect', url: string): boolean => {
    let prevented = false;
    contents.emit(event, { preventDefault: () => { prevented = true; } }, url);
    return prevented;
  };
  return { go, blocked, sites };
}

it('허용 목록 밖 링크 클릭은 차단하고 사용자에게 알린다', () => {
  const h = harness(['example.com']);
  expect(h.go('will-navigate', 'https://evil.com/steal')).toBe(true);
  expect(h.blocked).toEqual(['https://evil.com/steal']);
});

it('리다이렉트도 같은 판정을 받는다(링크만 막으면 우회로가 남는다)', () => {
  const h = harness(['example.com']);
  expect(h.go('will-redirect', 'https://evil.com/302')).toBe(true);
  expect(h.blocked).toEqual(['https://evil.com/302']);
});

it('허용 목록에 있으면 통과(알림도 없다)', () => {
  const h = harness(['example.com']);
  expect(h.go('will-navigate', 'https://example.com/page')).toBe(false);
  expect(h.blocked).toEqual([]);
});

it('localhost·file·data는 목록이 비어도 통과 — 기존 기능(로컬 미리보기·크게 보기)이 깨지면 안 된다', () => {
  const h = harness([]);
  expect(h.go('will-navigate', 'http://localhost:5173/x')).toBe(false);
  expect(h.go('will-navigate', 'file:///C:/tmp/a.html')).toBe(false);
  expect(h.go('will-navigate', 'data:text/html,<b>x</b>')).toBe(false);
  expect(h.go('will-redirect', 'http://127.0.0.1:3000/api')).toBe(false);
  expect(h.blocked).toEqual([]);
});

it('목록 조회가 던지면 막는 쪽으로 떨어진다(안전 우선)', () => {
  const contents = new EventEmitter();
  const blocked: string[] = [];
  attachNavGate(contents as never, () => { throw new Error('boom'); }, (u) => blocked.push(u));
  let prevented = false;
  contents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://example.com');
  expect(prevented).toBe(true);
  expect(blocked).toEqual(['https://example.com']);
});

it('알림 콜백이 던져도 차단은 유지된다', () => {
  const contents = new EventEmitter();
  attachNavGate(contents as never, () => [], () => { throw new Error('ui gone'); });
  let prevented = false;
  expect(() => contents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://evil.com')).not.toThrow();
  expect(prevented).toBe(true);
});
