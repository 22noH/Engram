import { FakeMessenger } from './fake-messenger';
import { bindMessenger } from './messenger-bridge';

const logger = { warn() {} } as any;

it('멘션 → handleMention 결과를 그 target에 reply', async () => {
  const m = new FakeMessenger();
  const orch = { handleMention: async (msg: any) => `답:${msg.text}@${msg.userId}` };
  bindMessenger(m, orch as any, logger);
  await m.emit({ text: '안녕', channelId: 'c1', authorId: 'u1', target: 'T1' });
  expect(m.replies).toEqual([{ target: 'T1', text: '답:안녕@c1' }]);
});

it('handleMention의 onAck도 같은 target으로 reply', async () => {
  const m = new FakeMessenger();
  const orch = { handleMention: async (_msg: any, onAck?: any) => { await onAck?.('알아볼게요'); return '결과'; } };
  bindMessenger(m, orch as any, logger);
  await m.emit({ text: 'x', channelId: 'c1', authorId: 'u1', target: 'T1' });
  expect(m.replies.map((r) => r.text)).toEqual(['알아볼게요', '결과']);
});

it('handleMention이 던지면 사과 메시지 + 로그(상주 안 죽음)', async () => {
  const m = new FakeMessenger();
  const warns: string[] = [];
  const orch = { handleMention: async () => { throw new Error('boom'); } };
  bindMessenger(m, orch as any, { warn: (msg: string) => warns.push(msg) } as any);
  await m.emit({ text: 'x', channelId: 'c1', authorId: 'u1', target: 'T1' });
  expect(m.replies[0].text).toContain('처리가 안 되네요');
  expect(warns.length).toBe(1);
});
