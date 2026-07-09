import { useEffect, useMemo, useRef, useState } from 'react';
import type { Channel, ClientFrame, Message as Msg, ServerFrame } from '../../shared/protocol';
import { loadConnections, saveConnections, setDefault, addConnection, removeConnection } from './connections';
import { useConnections } from './ws/connections-client';
import { routeTarget, logicalChannels, mergeThreads } from './multi';
import { Channels } from './components/Channels';
import { Thread } from './components/Thread';
import { Palette, filterCommands, MANAGE_ENGRAMS_INSERT } from './components/Palette';
import { FolderEmpty } from './components/FolderEmpty';
import { EngramSelector } from './components/EngramSelector';
import { ManageEngrams } from './components/ManageEngrams';
import { MentionAutocomplete, mentionCandidates } from './components/MentionAutocomplete';
import { T } from './i18n';

// 다중 연결 키 규약: `${connId}::${channelId}` (원시 메시지), `${connId}::${mode}::${name}` (채널id 매핑
// — 동일 연결에 동명·타모드 채널(예: chat "일반"과 code "일반")이 있어도 충돌 않게 mode로 한정한다).
// 채널은 이름+모드로 식별되는 논리 채널 — 여러 연결이 동명·동모드 채널을 가지면 하나로 합쳐 보인다.
function chanKey(connId: string, mode: string, name: string): string {
  return `${connId}::${mode}::${name}`;
}

export default function App() {
  const [connState, setConnState] = useState(() => loadConnections());
  useEffect(() => { saveConnections(connState); }, [connState]);

  const [channelsByConn, setChannelsByConn] = useState<Record<string, Channel[]>>({});
  const [chanIdByConnName, setChanIdByConnName] = useState<Map<string, string>>(new Map());
  const [msgsByConnCh, setMsgsByConnCh] = useState<Map<string, Msg[]>>(new Map());
  const [currentName, setCurrentName] = useState<string | null>(null);
  const [mode, setMode] = useState<'chat' | 'code' | 'team'>('chat');
  const [awaiting, setAwaiting] = useState<Set<string>>(new Set()); // 키=논리 채널 이름
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [palFilter, setPalFilter] = useState<string | null>(null); // null=닫힘
  const [palIdx, setPalIdx] = useState(0);                          // 선택 인덱스(방향키)
  const [inputText, setInputText] = useState('');                   // 입력값 미러(@ 자동완성 필터용 — input은 여전히 비제어)
  const [mentionIdx, setMentionIdx] = useState(0);                  // @ 자동완성 선택 인덱스(방향키)
  const [showManage, setShowManage] = useState(false);              // Manage Engrams 모달
  const [errText, setErrText] = useState<Record<string, string>>({}); // connId → 최근 에러(연결별 — 서로 안 덮어씀)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const awaitTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const msgsRef = useRef<HTMLDivElement>(null);

  // 최신 값을 ref로도 들고 있는다(chat.html/Phase11의 currentRef 패턴) — WS 이벤트 콜백이
  // React 커밋 사이 타이밍에서도 항상 "마지막 렌더 기준 최신값"을 읽게 하기 위함.
  const currentNameRef = useRef<string | null>(null); currentNameRef.current = currentName;
  const chanIdByConnNameRef = useRef(chanIdByConnName); chanIdByConnNameRef.current = chanIdByConnName;
  const msgsByConnChRef = useRef(msgsByConnCh); msgsByConnChRef.current = msgsByConnCh;
  const channelsByConnRef = useRef(channelsByConn); channelsByConnRef.current = channelsByConn;
  const modeRef = useRef(mode); modeRef.current = mode;

  // 채널 생성→전송 2스텝 대기 버퍼: 연결당(target connId) 대기 전송 1건.
  // ponytail: 이름+모드 키 — 그 연결의 channels 프레임이 그 이름+모드를 갖고 돌아오면 flush
  // (모드를 안 보면 동명·타모드 채널로 잘못 flush될 수 있다 — Minor #4).
  const pendingSendRef = useRef<Map<string, { name: string; mode: string; text: string }>>(new Map());

  function onFrame(connId: string, f: ServerFrame) {
    if (f.t === 'channels') {
      setChannelsByConn((prev) => ({ ...prev, [connId]: f.list }));
      setChanIdByConnName((prev) => {
        const next = new Map(prev);
        // Minor: 이 연결의 기존 엔트리를 먼저 지우고 새로 채운다 — 삭제된 채널이 stale로 안 남게.
        for (const key of next.keys()) if (key.startsWith(`${connId}::`)) next.delete(key);
        for (const c of f.list) next.set(chanKey(connId, c.mode ?? 'chat', c.name), c.id);
        return next;
      });
      const pending = pendingSendRef.current.get(connId);
      if (pending) {
        const chan = f.list.find((c) => c.name === pending.name && (c.mode ?? 'chat') === pending.mode);
        if (chan) {
          send(connId, { t: 'send', channelId: chan.id, text: pending.text });
          pendingSendRef.current.delete(connId);
        }
      }
    } else if (f.t === 'history') {
      setMsgsByConnCh((prev) => new Map(prev).set(`${connId}::${f.channelId}`, f.messages));
    } else if (f.t === 'msg') {
      const key = `${connId}::${f.channelId}`;
      setMsgsByConnCh((prev) => {
        const next = new Map(prev);
        next.set(key, [...(next.get(key) ?? []), f.message]);
        return next;
      });
      if (f.message.authorId === 'engram') { // 답 도착 → 그 논리 채널 생각중 해제(chat.html replyArrived 이전)
        const name = channelsByConnRef.current[connId]?.find((c) => c.id === f.channelId)?.name;
        if (name) {
          const tm = awaitTimers.current.get(name);
          if (tm) { clearTimeout(tm); awaitTimers.current.delete(name); }
          setAwaiting((prev) => { const n = new Set(prev); n.delete(name); return n; });
        }
      }
    } else if (f.t === 'authErr') {
      setErrText((prev) => ({ ...prev, [connId]: T.authFailed }));
    } else if (f.t === 'error') {
      console.warn('server error:', f.text);
      setErrText((prev) => ({ ...prev, [connId]: f.text }));
    }
  }

  function onOpen(connId: string) {
    // 재연결 시 이 연결분 에러만 지운다(다른 연결의 에러를 덮어쓰지 않게 — 연결별 상태).
    setErrText((prev) => {
      if (!(connId in prev)) return prev;
      const next = { ...prev };
      delete next[connId];
      return next;
    });
    // 재연결 시 이 연결분만 파일 진실원과 재동기화(다른 연결의 캐시는 그대로 둔다).
    setMsgsByConnCh((prev) => {
      const next = new Map(prev);
      for (const key of next.keys()) if (key.startsWith(`${connId}::`)) next.delete(key);
      return next;
    });
    send(connId, { t: 'channels' });
    const name = currentNameRef.current;
    if (name) {
      const chanId = chanIdByConnNameRef.current.get(chanKey(connId, modeRef.current, name));
      if (chanId) send(connId, { t: 'history', channelId: chanId });
    }
  }

  const { send, statusById } = useConnections(connState.connections, onFrame, onOpen);

  // 연결이 제거되면 그 connId분 채널/메시지 캐시를 지운다 — 안 지우면 사이드바에 고스트 채널이 남는다.
  const connIds = connState.connections.map((c) => c.id).join(',');
  useEffect(() => {
    const live = new Set(connState.connections.map((c) => c.id));
    setChannelsByConn((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const id of Object.keys(next)) if (!live.has(id)) { delete next[id]; changed = true; }
      return changed ? next : prev;
    });
    setChanIdByConnName((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const key of next.keys()) if (!live.has(key.split('::')[0])) { next.delete(key); changed = true; }
      return changed ? next : prev;
    });
    setMsgsByConnCh((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const key of next.keys()) if (!live.has(key.split('::')[0])) { next.delete(key); changed = true; }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connIds]);

  // currentName 없거나 모드 전환으로 안 보이면 그 모드의 첫 논리 채널로(chat.html/Phase11 onSetMode 대체).
  useEffect(() => {
    const names = logicalChannels(channelsByConn, mode);
    setCurrentName((cur) => (cur && names.includes(cur) ? cur : (names[0] ?? null)));
  }, [channelsByConn, mode]);

  // currentName이 정해지거나(최초 선택 포함) 어느 연결의 channels 목록이 갱신될 때마다,
  // 그 이름 채널을 가진 모든 연결 중 아직 기록이 없는 곳에 history를 요청(둘 다에서 동시에 커버).
  useEffect(() => {
    if (!currentName) return;
    for (const c of connState.connections) {
      const chanId = chanIdByConnName.get(chanKey(c.id, mode, currentName));
      if (chanId && !msgsByConnCh.has(`${c.id}::${chanId}`)) {
        send(c.id, { t: 'history', channelId: chanId });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentName, mode, channelsByConn]);

  // 새 메시지/채널 전환/생각중 변화 시 맨 아래로(chat.html box.scrollTop=scrollHeight 이전).
  const mergedMsgs = useMemo(() => {
    if (!currentName) return [] as Msg[];
    const parts = connState.connections
      .map((c) => {
        const chanId = chanIdByConnName.get(chanKey(c.id, mode, currentName));
        if (!chanId) return null;
        return { connId: c.id, messages: msgsByConnCh.get(`${c.id}::${chanId}`) ?? [] };
      })
      .filter((x): x is { connId: string; messages: Msg[] } => x !== null);
    return mergeThreads(parts);
  }, [currentName, mode, connState.connections, chanIdByConnName, msgsByConnCh]);

  // anchor(및 답)의 소유 연결 — 스레드 답글을 그 스레드를 연 Engram으로 라우팅하는 데 쓰인다.
  const anchorConn = useMemo(() => {
    const m = new Map<string, string>();
    if (!currentName) return m;
    for (const c of connState.connections) {
      const chanId = chanIdByConnName.get(chanKey(c.id, mode, currentName));
      if (!chanId) continue;
      for (const msg of msgsByConnCh.get(`${c.id}::${chanId}`) ?? []) m.set(msg.id, c.id);
    }
    return m;
  }, [currentName, mode, connState.connections, chanIdByConnName, msgsByConnCh]);

  useEffect(() => {
    const box = msgsRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [currentName, mergedMsgs, awaiting]);

  // 사이드바용 논리 채널 목록(기존 Channels 컴포넌트는 id 기반 — 여기선 id=name으로 합성).
  const sidebarChannels: Channel[] = logicalChannels(channelsByConn, mode).map((name) => {
    const fromDefault = channelsByConn[connState.defaultConnId]?.find((c) => c.name === name && (c.mode ?? 'chat') === mode);
    const any = fromDefault ?? Object.values(channelsByConn).flat().find((c) => c.name === name && (c.mode ?? 'chat') === mode);
    return { id: name, name, respondMode: any?.respondMode ?? 'all', mode };
  });
  // Code 영역(헤더/폴더 empty state)은 간단화: 기본 Engram의 그 채널 기준.
  const defaultChan = currentName
    ? channelsByConn[connState.defaultConnId]?.find((c) => c.name === currentName && (c.mode ?? 'chat') === mode)
    : undefined;

  // 그 이름 채널을 가진 모든 연결에 프레임을 보낸다(삭제·respondMode 변경 팬아웃).
  const fanoutToName = (name: string, build: (channelId: string) => ClientFrame) => {
    for (const c of connState.connections) {
      const chanId = chanIdByConnName.get(chanKey(c.id, mode, name));
      if (chanId) send(c.id, build(chanId));
    }
  };

  // 답을 기대하며 "생각 중" 표시(멘션-전용 채널에서 비멘션이면 안 띄움 — chat.html expectReply 이전).
  const expectReply = (name: string, text: string, connId: string) => {
    const c = channelsByConn[connId]?.find((x) => x.name === name);
    if (c && c.respondMode === 'mention' && !/@engram/i.test(text)) return;
    const prev = awaitTimers.current.get(name); if (prev) clearTimeout(prev);
    awaitTimers.current.set(name, setTimeout(() => {
      awaitTimers.current.delete(name);
      setAwaiting((p) => { const n = new Set(p); n.delete(name); return n; });
    }, 180000));
    setAwaiting((p) => new Set(p).add(name));
  };

  // 전송 라우팅: threadId 있으면 그 앵커를 연 Engram으로, 없으면 @이름 또는 기본 Engram으로.
  // 대상 연결에 그 이름 채널이 아직 없으면(지연 생성) createChannel 먼저 보내고 1건 버퍼링,
  // 그 연결의 channels 프레임이 그 이름으로 돌아오면 onFrame이 flush한다.
  const sendText = (text: string, threadId?: string) => {
    if (!text.trim() || !currentName) return;
    const targetConnId = threadId
      ? (anchorConn.get(threadId) ?? connState.defaultConnId)
      : routeTarget(text, connState.defaultConnId, connState.connections);
    // Minor #5: 대상 연결 소켓이 안 열려 있으면 조용히 버리지 말고 그 연결 에러란에 안내만 남긴다
    // (전송·생각중 타이머 시작은 하지 않는다 — spec §7).
    if (!statusById[targetConnId]) {
      const targetName = connState.connections.find((c) => c.id === targetConnId)?.name ?? targetConnId;
      setErrText((prev) => ({ ...prev, [targetConnId]: T.notConnected(targetName) }));
      return;
    }
    const channelId = chanIdByConnName.get(chanKey(targetConnId, mode, currentName));
    if (channelId) {
      send(targetConnId, { t: 'send', channelId, text, threadId });
    } else if (!threadId) {
      pendingSendRef.current.set(targetConnId, { name: currentName, mode, text });
      send(targetConnId, { t: 'createChannel', name: currentName, mode });
    }
    expectReply(currentName, text, targetConnId);
  };

  // '/'명령 팔레트에서 클릭·Enter로 명령을 입력창에 채운다(chat.html pickCmd 이전).
  // 단, 'engram' 항목은 텍스트가 아니라 동작 — Manage Engrams 모달을 연다.
  const pickCmd = (insert: string) => {
    setPalFilter(null);
    if (insert === MANAGE_ENGRAMS_INSERT) { setShowManage(true); return; }
    const i = document.getElementById('input') as HTMLInputElement;
    i.value = insert; i.focus(); setInputText(insert);
  };

  // '@' 자동완성에서 클릭·Enter로 이름을 고르면 커서 앞 '@토큰'을 '@이름 '으로 치환한다.
  const pickMention = (name: string) => {
    const i = document.getElementById('input') as HTMLInputElement;
    const v = i.value.replace(/(^|\s)@(\S*)$/, (_all, pre: string) => `${pre}@${name} `);
    i.value = v; i.focus(); setInputText(v);
  };
  const mentionNames = connState.connections.map((c) => c.name);

  return (
    <>
      <div id="titlebar">
        <span id="dot" className={statusById[connState.defaultConnId] ? 'on' : ''} title={errText[connState.defaultConnId] ?? ''} />
        <span id="tbtitle">Engram Desktop</span>
      </div>
      {showManage && (
        <ManageEngrams
          connections={connState.connections}
          defaultConnId={connState.defaultConnId}
          onAdd={(name, endpoint, token) => setConnState((s) => addConnection(s, name, endpoint, token))}
          onRemove={(id) => setConnState((s) => removeConnection(s, id))}
          onSetDefault={(id) => setConnState((s) => setDefault(s, id))}
          onClose={() => setShowManage(false)}
        />
      )}
      <div id="app">
        <Channels
          channels={sidebarChannels} current={currentName} mode={mode}
          onSelect={(name) => setCurrentName(name)} onSetMode={setMode}
          onCreate={(name, m) => send(connState.defaultConnId, { t: 'createChannel', name, mode: m })}
          onDelete={(name) => fanoutToName(name, (id) => ({ t: 'deleteChannel', id }))}
          onSetRespondMode={(name, m) => fanoutToName(name, (id) => ({ t: 'setRespondMode', id, mode: m }))}
        />
        <div id="main">
          {currentName && mode === 'code' && defaultChan?.repoPath && (
            <div id="chhdr" style={{ display: 'block' }} title={defaultChan.repoPath}>
              {'📁 ' + defaultChan.repoPath.split(/[\\/]/).filter(Boolean).pop()}
            </div>
          )}
          {currentName && mode === 'code' && !defaultChan?.repoPath ? (
            <FolderEmpty onSetRepo={(p) => { if (defaultChan) send(connState.defaultConnId, { t: 'setRepoPath', id: defaultChan.id, repoPath: p }); }} />
          ) : (
            <>
              <div id="msgs" ref={msgsRef}>
                {(() => {
                  const byAnchor = new Map<string, Msg[]>();
                  for (const m of mergedMsgs) {
                    if (m.threadId) {
                      const list = byAnchor.get(m.threadId);
                      if (list) list.push(m); else byAnchor.set(m.threadId, [m]);
                    }
                  }
                  return mergedMsgs.filter((m) => !m.threadId).map((m) => (
                    <Thread key={m.id} anchor={m} replies={byAnchor.get(m.id) ?? []}
                      draft={drafts.get(m.id) ?? ''}
                      collapsed={collapsed.has(m.id)}
                      onToggle={(c) => setCollapsed((prev) => { const n = new Set(prev); c ? n.add(m.id) : n.delete(m.id); return n; })}
                      onDraft={(v) => setDrafts((p) => new Map(p).set(m.id, v))}
                      onReply={(text) => { sendText(text, m.id); setDrafts((p) => { const n = new Map(p); n.delete(m.id); return n; }); }}
                      onSend={(text) => sendText(text)} />
                  ));
                })()}
                {currentName && awaiting.has(currentName) && (
                  <div className="typing"><span>{T.thinking}</span><span className="dots" /></div>
                )}
              </div>
              {palFilter !== null ? (
                <Palette filter={palFilter} selected={palIdx} onPick={pickCmd} />
              ) : (
                <MentionAutocomplete text={inputText} names={mentionNames} selected={mentionIdx} onPick={pickMention} />
              )}
              <div id="inputbar" style={currentName ? undefined : { display: 'none' }}>
                <input id="input" type="text" placeholder={T.placeholder}
                  onChange={(e) => {
                    const v = e.target.value;
                    setInputText(v);
                    const open = v.startsWith('/');
                    setPalFilter(open ? v.slice(1).toLowerCase() : null);
                    setPalIdx(0);
                    setMentionIdx(0);
                  }}
                  onKeyDown={(e) => {
                    if (palFilter !== null) { // 팔레트 열림: 방향키/Enter/Esc는 팔레트 조작(전송 아님)
                      const items = filterCommands(palFilter);
                      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); setPalIdx((p) => (p + 1) % items.length); return; }
                      if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); setPalIdx((p) => (p - 1 + items.length) % items.length); return; }
                      if (e.key === 'Enter' && items.length) { e.preventDefault(); pickCmd(items[Math.min(palIdx, items.length - 1)].insert); return; }
                      if (e.key === 'Escape') { setPalFilter(null); return; }
                    } else { // 팔레트 닫힘: '@' 자동완성 열려 있으면 방향키/Enter는 그쪽 조작
                      const items = mentionCandidates(inputText, mentionNames);
                      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); setMentionIdx((p) => (p + 1) % items.length); return; }
                      if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); setMentionIdx((p) => (p - 1 + items.length) % items.length); return; }
                      if (e.key === 'Enter' && items.length) { e.preventDefault(); pickMention(items[Math.min(mentionIdx, items.length - 1)]); return; }
                    }
                    if (e.key === 'Enter') {
                      const i = e.target as HTMLInputElement;
                      sendText(i.value); i.value = ''; setInputText('');
                    }
                  }} />
                <EngramSelector
                  connections={connState.connections}
                  defaultConnId={connState.defaultConnId}
                  statusById={statusById}
                  onSetDefault={(id) => setConnState((s) => setDefault(s, id))}
                  onManage={() => setShowManage(true)}
                />
                <button onClick={() => { const i = document.getElementById('input') as HTMLInputElement; sendText(i.value); i.value = ''; setInputText(''); }}>{T.send}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
