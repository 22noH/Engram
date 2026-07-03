import { MessengerHub } from './messenger-hub';

function makePoster() {
  const calls: Array<{ channelId: string; text: string; threadId?: string }> = [];
  return {
    calls,
    async postToChannel(channelId: string, text: string, threadId?: string) {
      calls.push({ channelId, text, threadId });
    },
  };
}

describe('MessengerHub', () => {
  it('self가 아는 채널이면 self로', async () => {
    const self = makePoster();
    const discord = makePoster();
    const hub = new MessengerHub({ has: (id) => id === 'general' }, self, discord);
    await hub.postToChannel('general', 'hi', 'th-1');
    expect(self.calls).toEqual([{ channelId: 'general', text: 'hi', threadId: 'th-1' }]);
    expect(discord.calls).toHaveLength(0);
  });

  it('모르는 채널이면 fallback(Discord)으로', async () => {
    const self = makePoster();
    const discord = makePoster();
    const hub = new MessengerHub({ has: () => false }, self, discord);
    await hub.postToChannel('123456789', 'hi');
    expect(discord.calls).toHaveLength(1);
    expect(self.calls).toHaveLength(0);
  });

  it('fallback 없으면 self로 강등(단독 운용)', async () => {
    const self = makePoster();
    const hub = new MessengerHub({ has: () => false }, self);
    await hub.postToChannel('anything', 'hi');
    expect(self.calls).toHaveLength(1);
  });
});
