import { CoreMessage } from './core-message';

describe('CoreMessage', () => {
  it('text와 userId 필드를 갖는다', () => {
    const msg: CoreMessage = { text: '질문', userId: 'default' };
    expect(msg.text).toBe('질문');
    expect(msg.userId).toBe('default');
  });
});
