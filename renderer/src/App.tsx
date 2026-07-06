import { useCallback, useRef, useState } from 'react';
import type { Channel, Message as Msg, ServerFrame } from '../../shared/protocol';
import { useWs } from './ws/client';
import { Channels } from './components/Channels';
import { Message } from './components/Message';
import { T } from './i18n';

export default function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [mode, setMode] = useState<'chat' | 'code'>('chat');
  const [msgsByCh, setMsgsByCh] = useState<Map<string, Msg[]>>(new Map());
  const currentRef = useRef<string | null>(null); currentRef.current = current;

  const onFrame = useCallback((f: ServerFrame) => {
    if (f.t === 'channels') {
      setChannels(f.list);
      setCurrent((cur) => (cur && f.list.some((c) => c.id === cur) ? cur : (f.list[0]?.id ?? null)));
    } else if (f.t === 'history') {
      setMsgsByCh((prev) => new Map(prev).set(f.channelId, f.messages));
    } else if (f.t === 'msg') {
      setMsgsByCh((prev) => {
        const next = new Map(prev);
        next.set(f.channelId, [...(next.get(f.channelId) ?? []), f.message]);
        return next;
      });
    } else if (f.t === 'error') {
      console.warn('server error:', f.text);
    }
  }, []);

  const onOpen = useCallback(() => {
    setMsgsByCh(new Map()); // 재연결 시 파일 진실원과 재동기화
    send({ t: 'channels' });
    if (currentRef.current) send({ t: 'history', channelId: currentRef.current });
  }, []);

  const { send, connected } = useWs(onFrame, onOpen);

  const selectChannel = (id: string) => {
    setCurrent(id);
    if (!msgsByCh.has(id)) send({ t: 'history', channelId: id });
  };
  const onSetMode = (m: 'chat' | 'code') => {
    setMode(m);
    const visible = channels.filter((c) => (c.mode || 'chat') === m);
    if (!visible.some((c) => c.id === current)) setCurrent(visible[0]?.id ?? null);
  };

  const ch = channels.find((c) => c.id === current);
  const fill = (text: string) => { const i = document.getElementById('input') as HTMLInputElement | null; if (i) { i.value = text; i.focus(); } };
  const sendText = (text: string, threadId?: string) => {
    if (!text.trim() || !current) return;
    send({ t: 'send', channelId: current, text, threadId });
  };

  return (
    <>
      <div id="titlebar"><span id="dot" className={connected ? 'on' : ''} /><span id="tbtitle">Engram</span></div>
      <div id="app">
        <Channels
          channels={channels} current={current} mode={mode}
          onSelect={selectChannel} onSetMode={onSetMode}
          onCreate={(name, m) => send({ t: 'createChannel', name, mode: m })}
          onDelete={(id) => send({ t: 'deleteChannel', id })}
          onSetRespondMode={(id, m) => send({ t: 'setRespondMode', id, mode: m })}
        />
        <div id="main">
          <div id="msgs">
            {(msgsByCh.get(current ?? '') ?? []).filter((m) => !m.threadId).map((m) => (
              <Message key={m.id} m={m} onPick={fill} />
            ))}
          </div>
          <div id="inputbar" style={ch ? undefined : { display: 'none' }}>
            <input id="input" type="text" placeholder={T.placeholder}
              onKeyDown={(e) => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value; sendText(v); (e.target as HTMLInputElement).value = ''; } }} />
            <button onClick={() => { const i = document.getElementById('input') as HTMLInputElement; sendText(i.value); i.value = ''; }}>{T.send}</button>
          </div>
        </div>
      </div>
    </>
  );
}
