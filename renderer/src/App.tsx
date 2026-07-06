import { useCallback, useRef, useState } from 'react';
import type { Channel, Message as Msg, ServerFrame } from '../../shared/protocol';
import { useWs } from './ws/client';
import { Channels } from './components/Channels';
import { Thread } from './components/Thread';
import { T } from './i18n';

export default function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [mode, setMode] = useState<'chat' | 'code'>('chat');
  const [msgsByCh, setMsgsByCh] = useState<Map<string, Msg[]>>(new Map());
  const [awaiting, setAwaiting] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const awaitTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
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
      if (f.message.authorId === 'engram') { // 답 도착 → 생각 중 해제(chat.html replyArrived 이전)
        const tm = awaitTimers.current.get(f.channelId);
        if (tm) { clearTimeout(tm); awaitTimers.current.delete(f.channelId); }
        setAwaiting((prev) => { const n = new Set(prev); n.delete(f.channelId); return n; });
      }
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

  // 답을 기대하며 "생각 중" 표시(멘션-전용 채널에서 비멘션이면 안 띄움 — chat.html expectReply 이전).
  const expectReply = (channelId: string, text: string) => {
    const c = channels.find((x) => x.id === channelId);
    if (c && c.respondMode === 'mention' && !/@engram/i.test(text)) return;
    const prev = awaitTimers.current.get(channelId); if (prev) clearTimeout(prev);
    awaitTimers.current.set(channelId, setTimeout(() => {
      awaitTimers.current.delete(channelId);
      setAwaiting((p) => { const n = new Set(p); n.delete(channelId); return n; });
    }, 180000));
    setAwaiting((p) => new Set(p).add(channelId));
  };

  const sendText = (text: string, threadId?: string) => {
    if (!text.trim() || !current) return;
    send({ t: 'send', channelId: current, text, threadId });
    expectReply(current, text);
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
            {(() => {
              const msgs = msgsByCh.get(current ?? '') ?? [];
              const byAnchor = new Map<string, Msg[]>();
              for (const m of msgs) {
                if (m.threadId) {
                  const list = byAnchor.get(m.threadId);
                  if (list) list.push(m); else byAnchor.set(m.threadId, [m]);
                }
              }
              return msgs.filter((m) => !m.threadId).map((m) => (
                <Thread key={m.id} anchor={m} replies={byAnchor.get(m.id) ?? []}
                  draft={drafts.get(m.id) ?? ''}
                  onDraft={(v) => setDrafts((p) => new Map(p).set(m.id, v))}
                  onReply={(text) => { sendText(text, m.id); setDrafts((p) => { const n = new Map(p); n.delete(m.id); return n; }); }}
                  onPick={fill} />
              ));
            })()}
            {current && awaiting.has(current) && (
              <div className="typing"><span>{T.thinking}</span><span className="dots" /></div>
            )}
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
