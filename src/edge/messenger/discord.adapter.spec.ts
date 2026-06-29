import { DiscordAdapter } from './discord.adapter';

// 네트워크 글루라 단위테스트 불가 — 생성·핸들러 등록이 throw 없이 되는지 스모크만.
it('생성과 onMention 등록이 throw 없이 된다(로그인 없음)', () => {
  const a = new DiscordAdapter({ provider: 'discord', token: 'x' });
  expect(() => a.onMention(async () => {})).not.toThrow();
});
