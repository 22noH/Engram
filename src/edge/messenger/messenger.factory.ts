import { MessengerPort, MessengerConfig } from './messenger.port';

// messenger.json provider → 어댑터(brain.factory/supervisor.factory와 동일 패턴).
// provider 없음 → null(비활성). discord이나 token 없음 → null. 미지원 → throw.
// 새 메신저 추가 = case 1개 + 어댑터 파일 1개. 코어 무변경.
export function createMessenger(cfg: MessengerConfig): MessengerPort | null {
  if (!cfg.provider) return null;
  switch (cfg.provider) {
    case 'discord': {
      if (!cfg.token) return null;
      const { DiscordAdapter } = require('./discord.adapter'); // 지연 로드: discord.js 미사용 시 안 끌어옴
      return new DiscordAdapter(cfg);
    }
    default:
      throw new Error(`지원하지 않는 messenger provider: ${cfg.provider}`);
  }
}
