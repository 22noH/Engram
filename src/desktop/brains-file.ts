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
