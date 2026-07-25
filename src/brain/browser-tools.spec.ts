import { BROWSER_TOOL_DEFS, executeBrowserTool, toBrowserOp } from './browser-tools';
import { BROWSER_TOOL_NAMES } from '../../shared/browser-ops';

describe('browser 도구 정의', () => {
  it('7개 도구가 계약된 이름 그대로 노출된다', () => {
    expect(BROWSER_TOOL_DEFS.map((d) => d.name)).toEqual([...BROWSER_TOOL_NAMES]);
  });
  it('입력 도구 설명은 로그인·결제 거부를 명시한다(모델이 시도조차 안 하게)', () => {
    const typeDef = BROWSER_TOOL_DEFS.find((d) => d.name === 'browser_type');
    expect(typeDef?.description).toMatch(/payment|password/i);
  });
});

describe('toBrowserOp — 인자 검증(never-throw)', () => {
  it('정상 변환', () => {
    expect(toBrowserOp('browser_navigate', { url: ' http://localhost:5173 ' })).toEqual({ kind: 'navigate', url: 'http://localhost:5173' });
    expect(toBrowserOp('browser_click', { target: 'text=로그인' })).toEqual({ kind: 'click', target: 'text=로그인' });
    expect(toBrowserOp('browser_type', { target: '#email', text: 'a@b.com' })).toEqual({ kind: 'type', target: '#email', text: 'a@b.com' });
    expect(toBrowserOp('browser_type', { target: '#q', text: 'x', submit: true })).toEqual({ kind: 'type', target: '#q', text: 'x', submit: true });
    expect(toBrowserOp('browser_read', {})).toEqual({ kind: 'read' });
    expect(toBrowserOp('browser_read', { selector: 'main' })).toEqual({ kind: 'read', selector: 'main' });
    expect(toBrowserOp('browser_console', {})).toEqual({ kind: 'console' });
    expect(toBrowserOp('browser_network', {})).toEqual({ kind: 'network' });
    expect(toBrowserOp('browser_screenshot', {})).toEqual({ kind: 'screenshot' });
  });
  it('빈 인자는 사유 문자열', () => {
    expect(toBrowserOp('browser_navigate', {})).toMatch(/url\(string\) required/);
    expect(toBrowserOp('browser_click', { target: '   ' })).toMatch(/target\(string\) required/);
    expect(toBrowserOp('browser_type', { target: '#a' })).toMatch(/text\(string\) required/);
    expect(toBrowserOp('nope', {})).toMatch(/unknown tool/);
  });
  it('빈 문자열 입력은 허용한다(칸 비우기)', () => {
    expect(toBrowserOp('browser_type', { target: '#a', text: '' })).toEqual({ kind: 'type', target: '#a', text: '' });
  });
});

describe('executeBrowserTool', () => {
  it('exec 미주입이면 안내 텍스트', async () => {
    await expect(executeBrowserTool('browser_read', {})).resolves.toMatch(/not wired/);
  });
  it('exec 결과 텍스트를 그대로 돌려준다', async () => {
    const r = await executeBrowserTool('browser_read', {}, async () => ({ ok: true, text: 'page text' }));
    expect(r).toBe('page text');
  });
  it('exec가 던져도 에러 텍스트로 흡수(도구 루프가 안 죽는다)', async () => {
    const r = await executeBrowserTool('browser_click', { target: '#a' }, async () => { throw new Error('boom'); });
    expect(r).toMatch(/browser error: boom/);
  });
  it('모르는 도구 이름은 exec를 부르지 않는다', async () => {
    const exec = jest.fn();
    await expect(executeBrowserTool('browser_hack', {}, exec)).resolves.toMatch(/unknown tool/);
    expect(exec).not.toHaveBeenCalled();
  });
});
