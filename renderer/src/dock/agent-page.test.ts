import { clickScript, inspectScript, networkScript, readScript, typeScript } from './agent-page';

// 주입 스크립트는 자기완결 IIFE라 jsdom에서 그대로 실행해 검증할 수 있다 —
// "페이지에서 실제로 무슨 일이 벌어지는가"를 모의가 아니라 진짜 DOM으로 못박는다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const exec = (code: string): any => (0, eval)(code);

beforeEach(() => { document.body.innerHTML = ''; });

describe('요소 찾기', () => {
  it('CSS 선택자', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    expect(exec(clickScript('#go', 'Click')).ok).toBe(true);
  });

  it('text= 로 사람이 보는 글자를 찍는다', () => {
    document.body.innerHTML = '<button id="a">Cancel</button><button id="b">Sign in</button>';
    let clicked = '';
    document.getElementById('b')!.addEventListener('click', () => { clicked = 'b'; });
    const r = exec(clickScript('text=Sign in', 'Click'));
    expect(r.ok).toBe(true);
    expect(clicked).toBe('b');
  });

  it('없는 요소는 not-found(추측해서 아무거나 누르지 않는다)', () => {
    document.body.innerHTML = '<button>Go</button>';
    expect(exec(clickScript('#missing', 'Click'))).toEqual({ ok: false, error: 'not-found' });
    expect(exec(clickScript('text=nothing like this', 'Click'))).toEqual({ ok: false, error: 'not-found' });
  });

  it('깨진 선택자도 예외 없이 not-found', () => {
    expect(exec(clickScript('>>>', 'Click')).ok).toBe(false);
  });
});

describe('조작 중인 요소 표시', () => {
  it('클릭하면 테두리+라벨이 화면에 붙는다', () => {
    document.body.innerHTML = '<button id="go">Go</button>';
    exec(clickScript('#go', 'Click'));
    const box = document.querySelector('[data-engram-highlight]');
    expect(box).not.toBeNull();
    expect(box!.textContent).toBe('Click');
  });
});

describe('입력', () => {
  it('값이 들어가고 input/change 이벤트가 뜬다(프레임워크가 붙은 칸도 반영되게)', () => {
    document.body.innerHTML = '<input id="email" />';
    const el = document.getElementById('email') as HTMLInputElement;
    const events: string[] = [];
    el.addEventListener('input', () => events.push('input'));
    el.addEventListener('change', () => events.push('change'));
    const r = exec(typeScript('#email', 'a@b.com', false, 'Type'));
    expect(r.ok).toBe(true);
    expect(el.value).toBe('a@b.com');
    expect(events).toEqual(['input', 'change']);
  });

  it('submit=true면 엔터까지 친다', () => {
    document.body.innerHTML = '<input id="q" />';
    const keys: string[] = [];
    document.getElementById('q')!.addEventListener('keydown', (e) => keys.push((e as KeyboardEvent).key));
    exec(typeScript('#q', 'hello', true, 'Type'));
    expect(keys).toEqual(['Enter']);
  });
});

describe('입력칸 정체 조회 — 로그인·결제 판정의 재료', () => {
  it('type/name/autocomplete/placeholder/label을 그대로 뽑아온다', () => {
    document.body.innerHTML =
      '<label for="pw">비밀번호</label><input id="pw" type="password" name="user_pw" autocomplete="current-password" placeholder="●●●●" />';
    const r = exec(inspectScript('#pw'));
    expect(r.ok).toBe(true);
    expect(r.field).toMatchObject({
      type: 'password', name: 'user_pw', id: 'pw', autocomplete: 'current-password', placeholder: '●●●●',
    });
    expect(r.field.label).toBe('비밀번호');
  });

  it('입력칸이 아니면 not-editable', () => {
    document.body.innerHTML = '<div id="x">hi</div>';
    expect(exec(inspectScript('#x'))).toMatchObject({ ok: false, error: 'not-editable' });
  });
});

describe('화면 읽기', () => {
  it('텍스트 + 조작 가능한 요소 목록(선택자 포함)을 돌려준다', () => {
    document.body.innerHTML = '<h1>Login</h1><input id="email" type="email" /><button>Sign in</button>';
    const r = exec(readScript(undefined, 1000, 20));
    expect(r.ok).toBe(true);
    expect(r.elements.map((e: { selector: string }) => e.selector)).toContain('#email');
    expect(r.elements.some((e: { kind: string }) => e.kind === 'input[email]')).toBe(true);
  });

  it('긴 본문은 잘리고 그 사실을 표시한다', () => {
    document.body.innerHTML = `<p>${'x'.repeat(300)}</p>`;
    const r = exec(readScript(undefined, 50, 5));
    expect(r.text).toContain('…(truncated)');
  });
});

describe('네트워크', () => {
  it('performance 항목이 없으면 빈 목록(예외 없음)', () => {
    const r = exec(networkScript(10));
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.requests)).toBe(true);
  });
});
