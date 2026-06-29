import { FakeMessenger } from './fake-messenger';
import { MentionEvent } from './messenger.port';

it('emit가 등록된 핸들러를 부르고 reply가 캡처된다', async () => {
  const m = new FakeMessenger();
  m.onMention(async (e: MentionEvent) => { await m.reply(e.target, `echo:${e.text}`); });
  await m.emit({ text: '안녕', channelId: 'c1', authorId: 'u1', target: { ch: 'c1' } });
  expect(m.replies).toEqual([{ target: { ch: 'c1' }, text: 'echo:안녕' }]);
});

it('핸들러 미등록이면 emit는 조용히 통과', async () => {
  const m = new FakeMessenger();
  await expect(m.emit({ text: 'x', channelId: 'c', authorId: 'u', target: null })).resolves.toBeUndefined();
});
