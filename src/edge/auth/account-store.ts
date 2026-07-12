import * as fs from 'fs';
import * as path from 'path';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { sanitizePermissions, type Permission } from './permissions';

// 계정 저장소(Phase 16a 스펙 §2.2). accounts.json 단일 파일, 손상 시 빈 목록(chat-store 관례).
// 비밀번호 = scrypt(사용자별 salt) 해시만 저장. 'engram'은 예약(사칭 방지).

export type AccountRole = 'owner' | 'member';
export type AccountStatus = 'pending' | 'active' | 'suspended';
export interface Account {
  id: string; loginId: string; displayName: string;
  pass?: { salt: string; hash: string };
  oidc?: { issuer: string; sub: string; email?: string };
  role: AccountRole; status: AccountStatus; createdAt: string;
  permissions?: string[]; // Phase 16b — member의 세분 권한. owner는 전권이라 무시.
}

const RESERVED = 'engram';
function hashPw(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

export class AccountStore {
  constructor(private readonly stateDir: string) {}

  private file(): string { return path.join(this.stateDir, 'accounts.json'); }

  private load(): Account[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as unknown;
      return Array.isArray(raw) ? (raw as Account[]) : [];
    } catch { return []; }
  }
  private save(list: Account[]): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(list, null, 2));
  }

  count(): number { return this.load().length; }
  list(): Account[] { return this.load(); }
  get(id: string): Account | null { return this.load().find((a) => a.id === id) ?? null; }
  getByLoginId(loginId: string): Account | null {
    const k = loginId.trim().toLowerCase();
    return this.load().find((a) => a.loginId?.toLowerCase() === k) ?? null;
  }
  getByOidc(issuer: string, sub: string): Account | null {
    return this.load().find((a) => a.oidc?.issuer === issuer && a.oidc?.sub === sub) ?? null;
  }

  private assertNames(loginId: string, displayName: string): void {
    if (!loginId.trim() || !displayName.trim()) throw new Error('empty name');
    if (loginId.trim().toLowerCase() === RESERVED || displayName.trim().toLowerCase() === RESERVED) {
      throw new Error('reserved name');
    }
    if (this.getByLoginId(loginId)) throw new Error('duplicate loginId');
  }

  createPassword(loginId: string, password: string, displayName: string,
    opts?: { role?: AccountRole; status?: AccountStatus }): Account {
    this.assertNames(loginId, displayName);
    const salt = randomBytes(16).toString('hex');
    const a: Account = {
      id: randomUUID(), loginId: loginId.trim(), displayName: displayName.trim(),
      pass: { salt, hash: hashPw(password, salt) },
      role: opts?.role ?? 'member', status: opts?.status ?? 'pending',
      createdAt: new Date().toISOString(),
    };
    const list = this.load(); list.push(a); this.save(list);
    return a;
  }

  createOidc(o: { issuer: string; sub: string; email?: string; displayName: string }): Account {
    // loginId는 이메일(없으면 issuer의 sub) — 로그인용이 아니라 식별 표시용. 충돌 시 sub를 붙여 유일화.
    let loginId = (o.email ?? `${o.sub}`).trim() || o.sub;
    if (this.getByLoginId(loginId)) loginId = `${loginId}#${o.sub}`;
    if (loginId.trim().toLowerCase() === RESERVED) loginId = `${loginId}#${o.sub}`;
    const name = o.displayName.trim().toLowerCase() === RESERVED ? loginId : o.displayName;
    const a: Account = {
      id: randomUUID(), loginId, displayName: name.trim() || loginId,
      oidc: { issuer: o.issuer, sub: o.sub, ...(o.email ? { email: o.email } : {}) },
      role: 'member', status: 'pending', createdAt: new Date().toISOString(),
    };
    const list = this.load(); list.push(a); this.save(list);
    return a;
  }

  verifyPassword(loginId: string, password: string): Account | null {
    const a = this.getByLoginId(loginId);
    // 계정 없어도 같은 비용의 해시를 계산(타이밍으로 존재 여부 유출 방지).
    const salt = a?.pass?.salt ?? '00'.repeat(16);
    const got = Buffer.from(hashPw(password, salt), 'hex');
    const want = Buffer.from(a?.pass?.hash ?? '00'.repeat(64), 'hex');
    const ok = got.length === want.length && timingSafeEqual(got, want);
    return ok && a?.pass ? a : null;
  }

  setStatus(id: string, status: AccountStatus): boolean {
    const list = this.load();
    const a = list.find((x) => x.id === id);
    if (!a) return false;
    a.status = status; this.save(list);
    return true;
  }

  setPassword(id: string, password: string): boolean {
    const list = this.load();
    const a = list.find((x) => x.id === id);
    if (!a) return false;
    const salt = randomBytes(16).toString('hex');
    a.pass = { salt, hash: hashPw(password, salt) };
    this.save(list);
    return true;
  }

  setPermissions(id: string, permissions: Permission[]): boolean {
    const list = this.load();
    const a = list.find((x) => x.id === id);
    if (!a) return false;
    if (a.role === 'owner') return true; // owner는 전권 — 배열 미기록(혼동 방지)
    a.permissions = sanitizePermissions(permissions);
    this.save(list);
    return true;
  }
}
