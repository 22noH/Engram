import { createMessenger } from './messenger.factory';

it('provider 없으면 null(메신저 비활성)', () => {
  expect(createMessenger({})).toBeNull();
});

it('discord인데 token 없으면 null', () => {
  expect(createMessenger({ provider: 'discord' })).toBeNull();
});

it('미지원 provider는 throw', () => {
  expect(() => createMessenger({ provider: 'icq', token: 't' })).toThrow(/지원하지 않는/);
});
