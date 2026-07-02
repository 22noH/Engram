import { DiscordAdapter, shouldHandleMessage, shouldObserveMessage, stripMentionTokens } from './discord.adapter';

// 네트워크 글루라 단위테스트 불가 — 생성·핸들러 등록이 throw 없이 되는지 스모크만.
it('생성과 onMention 등록이 throw 없이 된다(로그인 없음)', () => {
  const a = new DiscordAdapter({ provider: 'discord', token: 'x' });
  expect(() => a.onMention(async () => {})).not.toThrow();
});

it('봇 메시지는 무시, 멘션된 사람 메시지만 처리', () => {
  expect(shouldHandleMessage(true, true)).toBe(false);   // 봇
  expect(shouldHandleMessage(false, false)).toBe(false);  // 멘션 아님
  expect(shouldHandleMessage(false, true)).toBe(true);    // 처리
});

it('모든 멘션 토큰 제거 + trim', () => {
  expect(stripMentionTokens('<@123> 안녕 <@&456> <#789>')).toBe('안녕');
  expect(stripMentionTokens('  <@!1> 비용 줄여줘  ')).toBe('비용 줄여줘');
});

it('shouldObserveMessage: 봇 아님+멘션 아님만 true', () => {
  expect(shouldObserveMessage(false, false)).toBe(true);
  expect(shouldObserveMessage(true, false)).toBe(false);  // 봇
  expect(shouldObserveMessage(false, true)).toBe(false);  // 멘션(onMention 몫)
  expect(shouldObserveMessage(true, true)).toBe(false);
});
