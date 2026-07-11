import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionStore } from './session-store';

describe('SessionStore', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ses-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('issue → resolve, 토큰은 64자 hex', () => {
    const s = new SessionStore(dir);
    const sess = s.issue('u1');
    expect(sess.token).toMatch(/^[0-9a-f]{64}$/);
    expect(s.resolve(sess.token)?.userId).toBe('u1');
    expect(s.resolve('없는토큰')).toBeNull();
  });

  it('만료된 세션은 null + 삭제', () => {
    const s = new SessionStore(dir, -1000); // 즉시 만료 TTL
    const sess = s.issue('u1');
    expect(s.resolve(sess.token)).toBeNull();
    const raw = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8');
    expect(raw).not.toContain(sess.token);
  });

  it('revoke·revokeAllFor·재로드 영속', () => {
    const s = new SessionStore(dir);
    const a = s.issue('u1'); const b = s.issue('u1'); const c = s.issue('u2');
    s.revoke(a.token);
    expect(s.resolve(a.token)).toBeNull();
    s.revokeAllFor('u1');
    expect(s.resolve(b.token)).toBeNull();
    expect(new SessionStore(dir).resolve(c.token)?.userId).toBe('u2');
  });

  it('손상 파일 fault-tolerant', () => {
    fs.writeFileSync(path.join(dir, 'sessions.json'), 'not json');
    expect(new SessionStore(dir).resolve('x')).toBeNull();
  });
});
