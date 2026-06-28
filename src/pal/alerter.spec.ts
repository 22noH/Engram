import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { loadAlertConfig, sendAlert } from './alerter';

describe('alerter', () => {
  it('config 없으면 빈 설정', () => {
    expect(loadAlertConfig(path.join(os.tmpdir(), 'no-such-dir-xyz'))).toEqual({});
  });

  it('alert.json을 읽는다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-'));
    fs.writeFileSync(path.join(dir, 'alert.json'), JSON.stringify({ webhookUrl: 'http://x', command: 'notify' }));
    expect(loadAlertConfig(dir)).toEqual({ webhookUrl: 'http://x', command: 'notify' });
  });

  it('webhookUrl 있으면 POST한다', async () => {
    const calls: any[] = [];
    const fetchFn = async (url: string, init: any) => { calls.push({ url, init }); return { ok: true } as any; };
    await sendAlert({ webhookUrl: 'http://hook' }, 'down', '멈춤', { fetchFn });
    expect(calls[0].url).toBe('http://hook');
    expect(JSON.parse(calls[0].init.body).event).toBe('down');
  });

  it('command 있으면 spawn한다', async () => {
    const spawned: string[] = [];
    const spawnFn = (cmd: string) => { spawned.push(cmd); return { on: (_: string, cb: any) => cb(0) } as any; };
    await sendAlert({ command: 'notify-send' }, 'down', '멈춤', { spawnFn });
    expect(spawned[0]).toContain('notify-send');
  });

  it('둘 다 없으면 조용히 통과(no-op)', async () => {
    await expect(sendAlert({}, 'down', 'x')).resolves.toBeUndefined();
  });
});
