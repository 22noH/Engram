import { FakeMessenger } from './fake-messenger';
import { bindMessenger } from './messenger-bridge';

const logger = { warn() {} } as any;

it('멘션 → handleMention에 {text,userId=channelId}·post·threadKey 전달', async () => {
  const m = new FakeMessenger();
  const seen: any = {};
  const orch = { handleMention: async (msg: any, post: any, threadKey: any) => { seen.msg = msg; seen.threadKey = threadKey; await post('답'); } };
  bindMessenger(m, orch as any, logger);
  await m.emit({ text: '안녕', channelId: 'c1', threadId: 't1', authorId: 'u1', target: 'T1' });
  expect(seen.msg).toEqual({ text: '안녕', userId: 'c1' });
  expect(seen.threadKey).toBe('t1');
  expect(m.replies).toEqual([{ target: 'T1', text: '답' }]);
});

it('threadId 없으면 channelId가 threadKey', async () => {
  const m = new FakeMessenger();
  let tk: any;
  const orch = { handleMention: async (_m: any, _p: any, threadKey: any) => { tk = threadKey; } };
  bindMessenger(m, orch as any, logger);
  await m.emit({ text: 'x', channelId: 'c1', authorId: 'u1', target: 'T' });
  expect(tk).toBe('c1');
});

it('post는 그 target으로 reply(여러 번 게시 가능)', async () => {
  const m = new FakeMessenger();
  const orch = { handleMention: async (_m: any, post: any) => { await post('알아볼게요'); await post('결과'); } };
  bindMessenger(m, orch as any, logger);
  await m.emit({ text: 'x', channelId: 'c1', authorId: 'u1', target: 'T1' });
  expect(m.replies.map((r) => r.text)).toEqual(['알아볼게요', '결과']);
});

it('handleMention이 던지면 사과 + 로그(상주 불사)', async () => {
  const m = new FakeMessenger();
  const warns: string[] = [];
  const orch = { handleMention: async () => { throw new Error('boom'); } };
  bindMessenger(m, orch as any, { warn: (msg: string) => warns.push(msg) } as any);
  await m.emit({ text: 'x', channelId: 'c1', authorId: 'u1', target: 'T1' });
  expect(m.replies[0].text).toContain('처리가 안 되네요');
  expect(warns.length).toBe(1);
});
