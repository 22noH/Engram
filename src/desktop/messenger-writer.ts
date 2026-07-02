import * as fs from 'fs';
import * as path from 'path';

// 설정창 메신저 섹션(스펙 §4): 토큰을 messenger.json에 저장한다(반영은 상주 재시작).
export function saveDiscordToken(configDir: string, token: string): void {
  const file = path.join(configDir, 'messenger.json');
  let cfg: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') cfg = raw;
  } catch {
    // 없거나 깨짐 → 새로 씀
  }
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...cfg, provider: 'discord', token }, null, 2));
}
