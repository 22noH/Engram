import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

// 세션 저장소(스펙 §2.2). sessions.json, 만료 기본 30일 — 검사 시점은 제시될 때(resolve).

export interface Session { token: string; userId: string; createdAt: string; expiresAt: string }

export class SessionStore {
  constructor(
    private readonly stateDir: string,
    private readonly ttlMs: number = 30 * 24 * 3600 * 1000,
  ) {}

  private file(): string { return path.join(this.stateDir, 'sessions.json'); }
  private load(): Session[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as unknown;
      return Array.isArray(raw) ? (raw as Session[]) : [];
    } catch { return []; }
  }
  private save(list: Session[]): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(list, null, 2));
  }

  issue(userId: string): Session {
    const now = Date.now();
    const s: Session = {
      token: randomBytes(32).toString('hex'), userId,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
    const list = this.load(); list.push(s); this.save(list);
    return s;
  }

  resolve(token: string): Session | null {
    const list = this.load();
    const s = list.find((x) => x.token === token);
    if (!s) return null;
    if (new Date(s.expiresAt).getTime() <= Date.now()) {
      this.save(list.filter((x) => x.token !== token)); // 만료건 청소
      return null;
    }
    return s;
  }

  revoke(token: string): void {
    this.save(this.load().filter((x) => x.token !== token));
  }
  revokeAllFor(userId: string): void {
    this.save(this.load().filter((x) => x.userId !== userId));
  }
}
