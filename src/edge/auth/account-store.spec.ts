import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AccountStore } from './account-store';

describe('AccountStore', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('비밀번호 계정 생성·조회·검증', () => {
    const s = new AccountStore(dir);
    const a = s.createPassword('kim', 'pw1234', 'Kim', { role: 'owner', status: 'active' });
    expect(a.id).toBeTruthy();
    expect(s.count()).toBe(1);
    expect(s.getByLoginId('kim')?.id).toBe(a.id);
    expect(s.verifyPassword('kim', 'pw1234')?.id).toBe(a.id);
    expect(s.verifyPassword('kim', 'wrong')).toBeNull();
    expect(s.verifyPassword('nobody', 'pw1234')).toBeNull();
  });

  it('비밀번호는 원문 저장 안 함(파일에 pw 미포함)', () => {
    const s = new AccountStore(dir);
    s.createPassword('kim', 'secretpw', 'Kim');
    const raw = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8');
    expect(raw).not.toContain('secretpw');
  });

  it('중복 loginId·예약어 engram 거부', () => {
    const s = new AccountStore(dir);
    s.createPassword('kim', 'pw', 'Kim');
    expect(() => s.createPassword('kim', 'pw2', 'Kim2')).toThrow();
    expect(() => s.createPassword('Engram', 'pw', 'x')).toThrow();
    expect(() => s.createPassword('lee', 'pw', 'engram')).toThrow();
  });

  it('OIDC 계정: pending member로 생성, issuer+sub 조회', () => {
    const s = new AccountStore(dir);
    const a = s.createOidc({ issuer: 'https://idp', sub: 'u1', email: 'a@b.c', displayName: 'Lee' });
    expect(a.status).toBe('pending');
    expect(a.role).toBe('member');
    expect(s.getByOidc('https://idp', 'u1')?.id).toBe(a.id);
    expect(s.getByOidc('https://idp', 'zz')).toBeNull();
  });

  it('setStatus·setPassword·재로드 영속', () => {
    const s = new AccountStore(dir);
    const a = s.createPassword('kim', 'pw', 'Kim');
    expect(s.setStatus(a.id, 'suspended')).toBe(true);
    expect(s.setPassword(a.id, 'newpw')).toBe(true);
    const s2 = new AccountStore(dir); // 재로드
    expect(s2.get(a.id)?.status).toBe('suspended');
    expect(s2.verifyPassword('kim', 'newpw')?.id).toBe(a.id);
    expect(s2.setStatus('없는id', 'active')).toBe(false);
  });

  it('손상 파일 fault-tolerant: 빈 store로 시작', () => {
    fs.writeFileSync(path.join(dir, 'accounts.json'), '{broken');
    expect(new AccountStore(dir).count()).toBe(0);
  });
});
