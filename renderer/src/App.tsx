import { useCallback, useRef, useState } from 'react';
import type { Channel, Message as Msg, ServerFrame } from '../../shared/protocol';
import { useWs } from './ws/client';
import { Channels } from './components/Channels';
import { Thread } from './components/Thread';
import { Palette, filterCommands } from './components/Palette';
import { FolderEmpty } from './components/FolderEmpty';
import { T } from './i18n';

export default function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [mode, setMode] = useState<'chat' | 'code'>('chat');
  const [msgsByCh, setMsgsByCh] = useState<Map<string, Msg[]>>(new Map());
  const [awaiting, setAwaiting] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [palFilter, setPalFilter] = useState<string | null>(null); // null=닫힘
  const [palIdx, setPalIdx] = useState(0);                          // 선택 인덱스(방향키)
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

  // '/'명령 팔레트에서 클릭·Enter로 명령을 입력창에 채운다(chat.html pickCmd 이전).
  const pickCmd = (insert: string) => { const i = document.getElementById('input') as HTMLInputElement; i.value = insert; i.focus(); setPalFilter(null); };

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
          {ch && (ch.mode || 'chat') === 'code' && ch.repoPath && (
            <div id="chhdr" style={{ display: 'block' }} title={ch.repoPath}>
              {'📁 ' + ch.repoPath.split(/[\\/]/).filter(Boolean).pop()}
            </div>
          )}
          {ch && (ch.mode || 'chat') === 'code' && !ch.repoPath ? (
            <FolderEmpty onSetRepo={(p) => send({ t: 'setRepoPath', id: ch.id, repoPath: p })} />
          ) : (
            <>
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
              {palFilter !== null && (
                <Palette filter={palFilter} selected={palIdx} onPick={pickCmd} />
              )}
              <div id="inputbar" style={ch ? undefined : { display: 'none' }}>
                <input id="input" type="text" placeholder={T.placeholder}
                  onChange={(e) => { const v = e.target.value; const open = v.startsWith('/'); setPalFilter(open ? v.slice(1).toLowerCase() : null); setPalIdx(0); }}
                  onKeyDown={(e) => {
                    if (palFilter !== null) { // 팔레트 열림: 방향키/Enter/Esc는 팔레트 조작(전송 아님)
                      const items = filterCommands(palFilter);
                      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); setPalIdx((p) => (p + 1) % items.length); return; }
                      if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); setPalIdx((p) => (p - 1 + items.length) % items.length); return; }
                      if (e.key === 'Enter' && items.length) { e.preventDefault(); pickCmd(items[Math.min(palIdx, items.length - 1)].insert); return; }
                      if (e.key === 'Escape') { setPalFilter(null); return; }
                    }
                    if (e.key === 'Enter') {
                      const i = e.target as HTMLInputElement;
                      sendText(i.value); i.value = '';
                    }
                  }} />
                <button onClick={() => { const i = document.getElementById('input') as HTMLInputElement; sendText(i.value); i.value = ''; }}>{T.send}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
