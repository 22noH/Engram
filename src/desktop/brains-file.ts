import * as fs from 'fs';
import * as path from 'path';

// brains.json 병합 쓰기(설정창 공용): 다른 프로필·설정 보존, 깨진 파일은 기본 골격으로 재작성.
export function mergeBrainProfile(configDir: string, name: string, profile: Record<string, unknown>, setDefault = false): void {
  const file = path.join(configDir, 'brains.json');
  let cfg: { default: string; brains: Record<string, unknown> } = { default: 'claude', brains: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      const brains = typeof raw.brains === 'object' && raw.brains !== null && !Array.isArray(raw.brains) ? raw.brains : {};
      const def = typeof raw.default === 'string' ? raw.default : 'claude';
      cfg = { default: def, brains };
    }
  } catch {
    // 없거나 깨짐 → 기본 골격
  }
  cfg.brains[name] = profile;
  if (setDefault) cfg.default = name;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

// 두뇌 목록(설정창 드롭다운용). provider·model·기본여부.
export function listBrains(configDir: string): Array<{ key: string; provider: string; model: string; isDefault: boolean }> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, 'brains.json'), 'utf8'));
    const brains = raw && typeof raw.brains === 'object' && raw.brains ? raw.brains : {};
    const def = typeof raw?.default === 'string' ? raw.default : 'claude';
    return Object.keys(brains).map((key) => ({
      key,
      provider: String(brains[key]?.provider ?? ''),
      model: String(brains[key]?.model ?? ''),
      isDefault: key === def,
    }));
  } catch {
    return [];
  }
}

// 기본 두뇌 전환(default 필드만 갱신, 나머지 보존). 파일 없음/깨짐이면 no-op.
export function setDefaultBrain(configDir: string, key: string): void {
  const file = path.join(configDir, 'brains.json');
  let raw: { default?: string; brains?: Record<string, unknown> };
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!raw || typeof raw !== 'object') return;
  raw.default = key;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
}
