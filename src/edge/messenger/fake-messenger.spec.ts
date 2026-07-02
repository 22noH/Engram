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

it('postToChannel이 channelPosts에 캡처된다', async () => {
  const m = new FakeMessenger();
  await m.postToChannel('ch1', '안녕', 'th1');
  await m.postToChannel('ch2', '두번째');
  expect(m.channelPosts).toEqual([
    { channelId: 'ch1', threadId: 'th1', text: '안녕' },
    { channelId: 'ch2', threadId: undefined, text: '두번째' },
  ]);
});

it('onMessage/emitMessage: 관찰 메시지 왕복(6c-1)', async () => {
  const m = new FakeMessenger();
  const seen: string[] = [];
  m.onMessage(async (e) => { seen.push(`${e.channelId}:${e.text}`); });
  await m.emitMessage({ text: '일반 대화', channelId: 'c1', authorId: 'u1', target: null });
  expect(seen).toEqual(['c1:일반 대화']);
});

it('onMessage 핸들러 없이 emitMessage → 무해', async () => {
  const m = new FakeMessenger();
  await expect(m.emitMessage({ text: 'x', channelId: 'c1', authorId: 'u1', target: null })).resolves.toBeUndefined();
});
