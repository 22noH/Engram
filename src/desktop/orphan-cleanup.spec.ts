import { parseImageName, parseListeningPids } from './orphan-cleanup';

describe('orphan-cleanup 파싱', () => {
  const NETSTAT = [
    '',
    '활성 연결',
    '',
    '  프로토콜  로컬 주소              외부 주소              상태            PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234',
    '  TCP    127.0.0.1:47800        0.0.0.0:0              LISTENING       27852',
    '  TCP    127.0.0.1:47801        0.0.0.0:0              LISTENING       9999',
    '  TCP    127.0.0.1:52000        127.0.0.1:47800        ESTABLISHED     4444',
    '  TCP    [::1]:47800            [::]:0                 LISTENING       27852',
  ].join('\r\n');

  it('해당 포트를 LISTENING 중인 PID만 뽑는다(ESTABLISHED·타 포트 제외, 중복 dedupe)', () => {
    expect(parseListeningPids(NETSTAT, 47800)).toEqual([27852]);
  });

  it('점유자 없으면 빈 배열', () => {
    expect(parseListeningPids(NETSTAT, 48888)).toEqual([]);
  });

  it('빈/이상 출력 안전', () => {
    expect(parseListeningPids('', 47800)).toEqual([]);
    expect(parseListeningPids('garbage\nno match here', 47800)).toEqual([]);
  });

  it('tasklist CSV에서 이미지 이름 추출', () => {
    expect(parseImageName('"Engram.exe","27852","Console","1","210,000 K"')).toBe('Engram.exe');
    expect(parseImageName('"chrome.exe","1111","Console","1","1,000 K"')).toBe('chrome.exe');
  });

  it('tasklist 무결과(INFO 문구 등)면 null', () => {
    expect(parseImageName('정보: 지정된 조건에 일치하는 작업이 실행되고 있지 않습니다.')).toBeNull();
  });
});
