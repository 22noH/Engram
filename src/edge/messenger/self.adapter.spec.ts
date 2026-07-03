import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';
import { SelfMessenger, SelfTarget, hasEngramMention, stripEngramMention } from './self.adapter';
import { ChatStore } from './chat-store';
import { MentionEvent } from './messenger.port';

const noLog = { warn: () => {} };

function once<T = unknown>(ws: WebSocket, ev: string): Promise<T> {
  return new Promise((resolve) => ws.once(ev, (d: unknown) => resolve(d as T)));
}
async function nextFrame(ws: WebSocket): Promise<any> {
  const d = await once<Buffer>(ws, 'message');
  return JSON.parse(String(d));
}

describe('SelfMessenger 코어', () => {
  let dir: string;
  let store: ChatStore;
  let sm: SelfMessenger;
  let client: WebSocket;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-self-'));
    store = new ChatStore(dir);
    store.listChannels(); // general 생성
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1' }, store, { logger: noLog });
    await sm.start();
    client = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(client, 'open');
  });
  afterEach(async () => {
    client.terminate();
    await sm.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('멘션 유틸: 감지·제거(대소문자 무시)', () => {
    expect(hasEngramMention('@engram 안녕')).toBe(true);
    expect(hasEngramMention('그냥 잡담')).toBe(false);
    expect(stripEngramMention('@Engram  안녕')).toBe('안녕');
  });

  it('send → 영속 + msg 브로드캐스트 + onMention 발화(본류: threadId 없음, anchor=자기 id)', async () => {
    const events: MentionEvent[] = [];
    sm.onMention(async (e) => { events.push(e); });
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: '@Engram 안녕' }));
    const frame = await nextFrame(client);
    expect(frame.t).toBe('msg');
    expect(frame.message).toMatchObject({ authorId: 'owner', text: '@Engram 안녕' });
    expect(store.history('general')).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('안녕');            // 멘션 토큰 제거
    expect(events[0].threadId).toBeUndefined();      // 본류 → threadKey=channelId 정합
    expect((events[0].target as SelfTarget).anchorId).toBe(frame.message.id);
  });

  it('스레드 안 send → MentionEvent.threadId=anchor, target.anchorId=같은 anchor(새 스레드 안 팜)', async () => {
    const events: MentionEvent[] = [];
    sm.onMention(async (e) => { events.push(e); });
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'q', threadId: 'anchor-1' }));
    await nextFrame(client);
    expect(events[0].threadId).toBe('anchor-1');
    expect((events[0].target as SelfTarget).anchorId).toBe('anchor-1');
  });

  it('reply → engram 명의로 anchor 스레드에 영속+브로드캐스트', async () => {
    await sm.reply({ channelId: 'general', anchorId: 'a1' } as SelfTarget, '답입니다');
    const frame = await nextFrame(client);
    expect(frame.message).toMatchObject({ authorId: 'engram', text: '답입니다', threadId: 'a1' });
    expect(store.history('general')[0].threadId).toBe('a1');
  });

  it('postToChannel → 본류(threadId 없음) 게시, 클라이언트 0명이어도 영속', async () => {
    client.terminate();
    await sm.postToChannel('general', '예약 발사');
    expect(store.history('general')[0]).toMatchObject({ authorId: 'engram', text: '예약 발사' });
  });

  it('미존재 채널 send → error 프레임, 저장 안 함', async () => {
    client.send(JSON.stringify({ t: 'send', channelId: 'nope', text: 'x' }));
    const frame = await nextFrame(client);
    expect(frame.t).toBe('error');
  });

  it('손상 프레임·빈 text는 무시(서버 불사)', async () => {
    client.send('{broken');
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: '  ' }));
    client.send(JSON.stringify({ t: 'send', channelId: 'general', text: 'ok' }));
    const frame = await nextFrame(client);
    expect(frame.message.text).toBe('ok');
  });

  it('GET / 는 htmlPath 파일을 서빙, 없으면 404', async () => {
    const res = await fetch(`http://127.0.0.1:${sm.addressPort()}/`);
    expect(res.status).toBe(404); // htmlPath 미지정
    const htmlFile = path.join(dir, 'chat.html');
    fs.writeFileSync(htmlFile, '<p>hi</p>');
    const sm2 = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1' }, store, { htmlPath: htmlFile, logger: noLog });
    await sm2.start();
    const res2 = await fetch(`http://127.0.0.1:${sm2.addressPort()}/`);
    expect(res2.status).toBe(200);
    expect(await res2.text()).toContain('hi');
    await sm2.stop();
  });
});

describe('SelfMessenger 프로토콜 확장', () => {
  let dir: string;
  let store: ChatStore;
  let sm: SelfMessenger;
  let client: WebSocket;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-self2-'));
    store = new ChatStore(dir);
    store.listChannels();
    sm = new SelfMessenger({ enabled: true, port: 0, bind: '127.0.0.1' }, store, { logger: noLog });
    await sm.start();
    client = new WebSocket(`ws://127.0.0.1:${sm.addressPort()}`);
    await once(client, 'open');
  });
  afterEach(async () => {
    client.terminate();
    await sm.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('channels 요청 → 목록 응답', async () => {
    client.send(JSON.stringify({ t: 'channels' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('channels');
    expect(f.list[0].id).toBe('general');
  });

  it('createChannel → 생성 + channels 브로드캐스트', async () => {
    client.send(JSON.stringify({ t: 'createChannel', name: 'dev' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('channels');
    expect(f.list.map((c: { name: string }) => c.name)).toContain('dev');
  });

  it('deleteChannel·setRespondMode → 반영 + 브로드캐스트', async () => {
    const ch = store.createChannel('tmp')!;
    client.send(JSON.stringify({ t: 'setRespondMode', id: ch.id, mode: 'mention' }));
    const f1 = await nextFrame(client);
    expect(f1.list.find((c: { id: string }) => c.id === ch.id).respondMode).toBe('mention');
    client.send(JSON.stringify({ t: 'deleteChannel', id: ch.id }));
    const f2 = await nextFrame(client);
    expect(f2.list.find((c: { id: string }) => c.id === ch.id)).toBeUndefined();
  });

  it('history 요청 → 저장된 메시지 응답', async () => {
    store.appendMessage('general', { authorId: 'owner', text: 'old' });
    client.send(JSON.stringify({ t: 'history', channelId: 'general' }));
    const f = await nextFrame(client);
    expect(f.t).toBe('history');
    expect(f.messages.map((m: { text: string }) => m.text)).toEqual(['old']);
  });

  it("respondMode='mention': 멘션은 onMention, 비멘션은 onMessage(관찰)", async () => {
    const ch = store.createChannel('team')!;
    store.setRespondMode(ch.id, 'mention');
    const mentions: string[] = [];
    const observed: string[] = [];
    sm.onMention(async (e) => { mentions.push(e.text); });
    sm.onMessage(async (e) => { observed.push(e.text); });
    client.send(JSON.stringify({ t: 'send', channelId: ch.id, text: '@Engram 회의 잡아줘' }));
    await nextFrame(client);
    client.send(JSON.stringify({ t: 'send', channelId: ch.id, text: '그냥 잡담' }));
    await nextFrame(client);
    expect(mentions).toEqual(['회의 잡아줘']);
    expect(observed).toEqual(['그냥 잡담']);
  });
});
