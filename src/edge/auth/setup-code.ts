import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

// 1회용 서버 초기 설정 코드(스펙 §2.4). state/setup-code 파일 — 첫 owner 생성 성공 시 삭제.

function file(stateDir: string): string { return path.join(stateDir, 'setup-code'); }

export function ensureSetupCode(stateDir: string): string {
  const existing = readSetupCode(stateDir);
  if (existing) return existing;
  const code = randomBytes(16).toString('hex');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file(stateDir), code);
  return code;
}

export function readSetupCode(stateDir: string): string | null {
  try {
    const c = fs.readFileSync(file(stateDir), 'utf8').trim();
    return c || null;
  } catch { return null; }
}

export function clearSetupCode(stateDir: string): void {
  try { fs.rmSync(file(stateDir)); } catch { /* 없으면 무시 */ }
}
