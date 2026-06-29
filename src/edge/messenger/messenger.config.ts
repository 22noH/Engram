import * as fs from 'fs';
import * as path from 'path';
import { MessengerConfig } from './messenger.port';

// runtime/config/messenger.json 로드. 파일 없거나 깨지면 빈 설정(메신저 비활성).
// 비밀(token)은 env ENGRAM_DISCORD_TOKEN을 우선 — 파일에 토큰을 안 박아도 되게.
export function loadMessengerConfig(configDir: string): MessengerConfig {
  let cfg: MessengerConfig = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(configDir, 'messenger.json'), 'utf8')) as MessengerConfig;
  } catch {
    cfg = {};
  }
  return { ...cfg, token: process.env.ENGRAM_DISCORD_TOKEN ?? cfg.token };
}
