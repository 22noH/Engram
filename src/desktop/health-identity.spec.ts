import { classifyHealth } from './health-identity';

describe('classifyHealth', () => {
  const expectedId = 'my-instance-id-123';

  it('instanceId 일치 → ok(파싱된 객체)', () => {
    expect(classifyHealth({ ok: true, instanceId: expectedId }, expectedId)).toBe('ok');
  });

  it('instanceId 일치 → ok(JSON 문자열)', () => {
    expect(classifyHealth(JSON.stringify({ ok: true, instanceId: expectedId }), expectedId)).toBe('ok');
  });

  it('instanceId 불일치 → foreign(다른 인스턴스가 응답 중)', () => {
    expect(classifyHealth({ ok: true, instanceId: 'someone-elses-id' }, expectedId)).toBe('foreign');
  });

  it('instanceId 필드 부재 → foreign(구버전 데몬 — 안전측, 외부 인스턴스와 구분 불가)', () => {
    expect(classifyHealth({ ok: true }, expectedId)).toBe('foreign');
  });

  it('JSON 아님(파싱 실패) → pending(계속 폴링)', () => {
    expect(classifyHealth('not json at all', expectedId)).toBe('pending');
  });

  it('빈 문자열 → pending', () => {
    expect(classifyHealth('', expectedId)).toBe('pending');
  });

  it('연결 실패(본문 없음/undefined) → pending', () => {
    expect(classifyHealth(undefined, expectedId)).toBe('pending');
  });

  it('null → pending', () => {
    expect(classifyHealth(null, expectedId)).toBe('pending');
  });

  it('JSON이지만 객체가 아님(배열·숫자 등) → pending', () => {
    expect(classifyHealth('[1,2,3]', expectedId)).toBe('pending');
    expect(classifyHealth('42', expectedId)).toBe('pending');
    expect(classifyHealth(42, expectedId)).toBe('pending');
  });
});
