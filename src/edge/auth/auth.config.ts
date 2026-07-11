import * as fs from 'fs';
import * as path from 'path';

// 서버 인증 설정(스펙 §2.2). config/auth.json — 서버 이름 + OIDC 연동. 관리 화면에서 수정.

export interface OidcSettings { issuer: string; clientId: string; clientSecret: string }
export interface AuthSettings { serverName?: string; oidc?: OidcSettings }

export const OIDC_PRESETS: Record<string, string> = { google: 'https://accounts.google.com' };

export function loadAuthSettings(configDir: string): AuthSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'auth.json'), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const r = raw as Partial<AuthSettings>;
    const out: AuthSettings = {};
    if (typeof r.serverName === 'string' && r.serverName.trim()) out.serverName = r.serverName.trim();
    const o = r.oidc;
    if (o && typeof o.issuer === 'string' && typeof o.clientId === 'string' && typeof o.clientSecret === 'string') {
      out.oidc = { issuer: o.issuer, clientId: o.clientId, clientSecret: o.clientSecret };
    }
    return out;
  } catch { return {}; }
}

export function saveAuthSettings(configDir: string, s: AuthSettings): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify(s, null, 2));
}
