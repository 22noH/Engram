import {
  credentialBlockReason, hostOfUrl, isConfirmMode, isLocalNavUrl, isNavAllowed, needsConfirm,
} from '../../../shared/site-gate';

// 사이트 게이트 = 메인(이동 차단)과 렌더러(AI 조작 확인)가 공유하는 단일 판정원.
// 여기가 유일한 진실원이므로 경계값을 전부 못박는다.

describe('isLocalNavUrl — 내 컴퓨터/로컬 파일은 기본 허용', () => {
  it.each([
    ['file:///C:/tmp/a.html'],
    ['data:text/html,<b>hi</b>'],
    ['about:blank'],
    ['http://localhost:5173/login'],
    ['http://127.0.0.1:3000'],
    ['http://192.168.0.5:8080'],
    ['http://10.1.2.3'],
    ['http://172.16.0.1'],
    ['http://app.localhost:3000'],
    [''],
  ])('%s = 로컬', (url) => {
    expect(isLocalNavUrl(url)).toBe(true);
  });

  it.each([['https://example.com'], ['http://8.8.8.8'], ['https://sub.evil.co.kr/x']])('%s = 외부', (url) => {
    expect(isLocalNavUrl(url)).toBe(false);
  });

  it('URL이 아니면 외부로 본다(못 알아본 걸 통과시키지 않는다)', () => {
    expect(isLocalNavUrl('javascript:alert(1)')).toBe(false);
    expect(hostOfUrl('nonsense')).toBeNull();
  });
});

describe('isNavAllowed — 허용 목록 밖 외부 사이트는 이동 금지', () => {
  it('허용 목록에 있으면 통과(대소문자 무시)', () => {
    expect(isNavAllowed('https://Example.COM/a', ['example.com'])).toBe(true);
    expect(isNavAllowed('https://example.com/a', ['EXAMPLE.COM'])).toBe(true);
  });
  it('허용 목록 밖이면 차단', () => {
    expect(isNavAllowed('https://evil.com', ['example.com'])).toBe(false);
    expect(isNavAllowed('https://evil.com', [])).toBe(false);
  });
  it('서브도메인은 별개다(자동 확장 없음)', () => {
    expect(isNavAllowed('https://a.example.com', ['example.com'])).toBe(false);
  });
  it('로컬은 목록이 비어도 통과 — 기존 기능(로컬 미리보기·크게 보기)이 깨지면 안 된다', () => {
    expect(isNavAllowed('http://localhost:5173', [])).toBe(true);
    expect(isNavAllowed('file:///C:/x.html', [])).toBe(true);
    expect(isNavAllowed('data:text/html,x', [])).toBe(true);
  });
});

describe('needsConfirm — 자동 확인 3단계', () => {
  it('매번 묻기: 로컬이든 외부든 항상 확인', () => {
    expect(needsConfirm('ask', 'http://localhost:5173')).toBe(true);
    expect(needsConfirm('ask', 'https://example.com')).toBe(true);
  });
  it('내 컴퓨터에서만(기본): 로컬은 자동, 외부는 확인', () => {
    expect(needsConfirm('local', 'http://localhost:5173')).toBe(false);
    expect(needsConfirm('local', 'file:///C:/a.html')).toBe(false);
    expect(needsConfirm('local', 'https://example.com')).toBe(true);
  });
  it('항상 자동: 아무것도 안 묻는다', () => {
    expect(needsConfirm('auto', 'https://example.com')).toBe(false);
  });
  it('허용 목록에 있는 외부 사이트라도 조작은 확인받는다(열기 허용 ≠ 조작 허용)', () => {
    expect(needsConfirm('local', 'https://example.com')).toBe(true);
  });
  it('isConfirmMode는 오염된 저장값을 걸러낸다', () => {
    expect(isConfirmMode('local')).toBe(true);
    expect(isConfirmMode('nonsense')).toBe(false);
    expect(isConfirmMode(undefined)).toBe(false);
  });
});

describe('credentialBlockReason — 로그인·결제 입력은 어떤 설정에서도 금지', () => {
  it('비밀번호 칸', () => {
    expect(credentialBlockReason({ type: 'password' })).toBe('password-field');
    expect(credentialBlockReason({ type: 'PASSWORD' })).toBe('password-field');
    expect(credentialBlockReason({ autocomplete: 'current-password' })).toBe('password-field');
    expect(credentialBlockReason({ autocomplete: 'new-password' })).toBe('password-field');
    expect(credentialBlockReason({ name: 'user_password' })).toBe('password-field');
    expect(credentialBlockReason({ id: 'pwd' })).toBe('password-field');
    expect(credentialBlockReason({ placeholder: '비밀번호를 입력하세요' })).toBe('password-field');
    expect(credentialBlockReason({ label: 'Passwort' })).toBeNull(); // 모르는 언어는 못 잡는다(정직하게 기록)
  });
  it('일회용 인증번호도 로그인 자격증명으로 본다', () => {
    expect(credentialBlockReason({ autocomplete: 'one-time-code' })).toBe('payment-field');
    expect(credentialBlockReason({ name: 'otp' })).toBe('password-field');
    expect(credentialBlockReason({ label: '인증번호' })).toBe('password-field');
  });
  it('결제 정보 칸', () => {
    expect(credentialBlockReason({ autocomplete: 'cc-number' })).toBe('payment-field');
    expect(credentialBlockReason({ autocomplete: 'cc-csc' })).toBe('payment-field');
    expect(credentialBlockReason({ name: 'cardNumber' })).toBe('payment-field');
    expect(credentialBlockReason({ id: 'cvv' })).toBe('payment-field');
    expect(credentialBlockReason({ label: '카드번호' })).toBe('password-field'); // 카드 번호는 SECRET 규칙이 먼저 잡는다
    expect(credentialBlockReason({ placeholder: 'Credit card' })).toBe('payment-field');
  });
  it('평범한 칸은 통과', () => {
    expect(credentialBlockReason({ type: 'text', name: 'email' })).toBeNull();
    expect(credentialBlockReason({ type: 'email', autocomplete: 'username' })).toBeNull();
    expect(credentialBlockReason({ type: 'search', placeholder: '검색' })).toBeNull();
    expect(credentialBlockReason({})).toBeNull();
  });
});
