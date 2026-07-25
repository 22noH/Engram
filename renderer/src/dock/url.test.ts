import { displayUrl, hostOf, isLocalUrl, pathToFileUrl, toNavUrl, urlTitle } from './url';

describe('toNavUrl — 주소창 입력 해석', () => {
  it('http(s)는 그대로', () => {
    expect(toNavUrl('http://localhost:5173/a')).toBe('http://localhost:5173/a');
    expect(toNavUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('스킴 없는 로컬 주소는 http로 붙인다', () => {
    expect(toNavUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(toNavUrl('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
    expect(toNavUrl('192.168.0.5:3000')).toBe('http://192.168.0.5:3000');
  });

  it('도메인은 https로 붙인다', () => {
    expect(toNavUrl('example.com/docs')).toBe('https://example.com/docs');
    expect(toNavUrl('//example.com')).toBe('https://example.com');
  });

  it('윈도우 경로를 file:// 로 바꾼다(공백·한글 인코딩)', () => {
    expect(toNavUrl('C:\\Users\\me\\a.html')).toBe('file:///C:/Users/me/a.html');
    expect(toNavUrl('C:/Users/me/my file.html')).toBe('file:///C:/Users/me/my%20file.html');
    expect(toNavUrl('C:\\개발\\index.html')).toBe('file:///C:/' + encodeURIComponent('개발') + '/index.html');
  });

  it('유닉스 절대경로와 UNC 경로도 받는다', () => {
    expect(toNavUrl('/home/me/a.html')).toBe('file:///home/me/a.html');
    expect(toNavUrl('\\\\srv\\share\\a.html')).toBe('file://srv/share/a.html');
  });

  it('file: URL은 그대로', () => {
    expect(toNavUrl('file:///C:/x/y.html')).toBe('file:///C:/x/y.html');
  });

  it('위험하거나 모르는 스킴은 거부한다', () => {
    expect(toNavUrl('javascript:alert(1)')).toBeNull();
    expect(toNavUrl('data:text/html,<h1>x</h1>')).toBeNull();
    expect(toNavUrl('chrome://settings')).toBeNull();
    expect(toNavUrl('about:blank')).toBeNull();
  });

  it('주소가 아닌 말은 거부한다(무반응 금지 — 호출부가 안내를 띄운다)', () => {
    expect(toNavUrl('')).toBeNull();
    expect(toNavUrl('   ')).toBeNull();
    expect(toNavUrl('그냥 문장 입니다')).toBeNull();
    expect(toNavUrl('asdf')).toBeNull();
  });
});

describe('pathToFileUrl', () => {
  it('역슬래시를 슬래시로 바꾸고 드라이브 콜론은 살린다', () => {
    expect(pathToFileUrl('D:\\a\\b.txt')).toBe('file:///D:/a/b.txt');
  });
});

describe('displayUrl / urlTitle', () => {
  it('스킴을 숨기고 짧게 보여준다', () => {
    expect(displayUrl('http://localhost:5173/')).toBe('localhost:5173');
    expect(displayUrl('https://example.com/docs?q=1')).toBe('example.com/docs?q=1');
  });
  it('file은 경로로 보여준다', () => {
    expect(displayUrl('file:///C:/x/y.html')).toBe('C:/x/y.html');
  });
  it('data:는 잘라서 보여준다(주소창을 통째로 밀어내지 않게)', () => {
    expect(displayUrl('data:text/html,' + 'x'.repeat(500)).length).toBeLessThan(50);
  });
  it('제목은 파일명 또는 호스트', () => {
    expect(urlTitle('file:///C:/x/index.html')).toBe('index.html');
    expect(urlTitle('http://localhost:5173/a/b')).toBe('localhost:5173');
    expect(urlTitle('data:text/html,x')).toBe('HTML');
  });
});

describe('isLocalUrl / hostOf', () => {
  it('내 컴퓨터·사설망·로컬 파일은 로컬로 본다', () => {
    expect(isLocalUrl('http://localhost:5173')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isLocalUrl('http://192.168.0.9:47800')).toBe(true);
    expect(isLocalUrl('http://172.16.5.1')).toBe(true);
    expect(isLocalUrl('file:///C:/x.html')).toBe(true);
  });
  it('외부 사이트는 로컬이 아니다', () => {
    expect(isLocalUrl('https://example.com')).toBe(false);
    expect(isLocalUrl('http://8.8.8.8')).toBe(false);
  });
  it('hostOf는 호스트만 뽑고, URL이 아니면 null', () => {
    expect(hostOf('https://Example.COM/a')).toBe('example.com');
    expect(hostOf('nonsense')).toBeNull();
  });
});
