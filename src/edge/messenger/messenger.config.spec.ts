import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { loadMessengerConfig } from './messenger.config';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-msg-')); }

it('파일 없으면 빈 설정', () => {
  expect(loadMessengerConfig(tmp())).toEqual({ token: undefined });
});

it('messenger.json을 읽는다', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'messenger.json'), JSON.stringify({ provider: 'discord', token: 'file-tok' }));
  expect(loadMessengerConfig(dir)).toEqual({ provider: 'discord', token: 'file-tok' });
});

it('env ENGRAM_DISCORD_TOKEN이 파일 token보다 우선', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'messenger.json'), JSON.stringify({ provider: 'discord', token: 'file-tok' }));
  const prev = process.env.ENGRAM_DISCORD_TOKEN;
  process.env.ENGRAM_DISCORD_TOKEN = 'env-tok';
  try { expect(loadMessengerConfig(dir).token).toBe('env-tok'); }
  finally { if (prev === undefined) delete process.env.ENGRAM_DISCORD_TOKEN; else process.env.ENGRAM_DISCORD_TOKEN = prev; }
});
