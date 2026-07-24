import { useEffect, useMemo, useRef, useState } from 'react';
import type { Channel, ClientFrame, Message as Msg, RosterEntry, ServerFrame, UserDto } from '../../shared/protocol';
import { loadConnections, saveConnections, setDefault, addConnection, removeConnection } from './connections';
import { useConnections } from './ws/connections-client';
import { routeTarget, logicalChannels, mergeThreads, scopedConnections, scopedChannels } from './multi';
import { loadSessions, saveSessionFor, clearSessionFor } from './sessions';
import { fetchStatus, apiLogin, apiRegister, apiOidcBegin, apiOidcPoll, uploadAttachment, type AuthStatus } from './auth-api';
import { Channels } from './components/Channels';
import { ChannelMembers } from './components/ChannelMembers';
import { Thread } from './components/Thread';
import type { AttachmentCtx } from './components/Message';
import { Palette, filterCommands, MANAGE_ENGRAMS_INSERT, CLEAR_INSERT, COMPACT_INSERT } from './components/Palette';
import { FolderEmpty } from './components/FolderEmpty';
import { CodePanel, CodePanelIcons, loadCodeTab, saveCodeTab, type CodeTab } from './components/CodePanel';
import { EngramSelector } from './components/EngramSelector';
import { ManageEngrams } from './components/ManageEngrams';
import { MentionAutocomplete, mentionCandidates } from './components/MentionAutocomplete';
import { WikiArea } from './components/WikiArea';
import { AdminArea } from './components/AdminArea';
import { LoginGate } from './components/LoginGate';
import { allow } from './permissions';
import type { WikiPageMeta, WikiPageDto, ProposalDto, WikiSearchHit, AdminUserDto, AdminSettings } from '../../shared/protocol';
import { T } from './i18n';

// 다중 연결 키 규약: `${connId}::${channelId}` (원시 메시지), `${connId}::${mode}::${name}` (채널id 매핑
// — 동일 연결에 동명·타모드 채널(예: chat "일반"과 code "일반")이 있어도 충돌 않게 mode로 한정한다).
// 채널은 이름+모드로 식별되는 논리 채널 — 여러 연결이 동명·동모드 채널을 가지면 하나로 합쳐 보인다.
function chanKey(connId: string, mode: string, name: string): string {
  return `${connId}::${mode}::${name}`;
}

// 최종 재리뷰 minor(T4) — pendingSendRef(지연 생성 채널 버퍼)의 "flush 대상 판정" 순수 함수로 추출.
// 실제 UI로는 hasAttachments=true(첨부 있음)가 이 버퍼 분기(sendText의 else if (!threadId))와 동시에
// 일어날 수 없다 — 첨부는 항상 이미 존재하는 채널에만 업로드되고(addFiles가 업로드 전 채널 존재를
// 요구 — 서버 POST /attachments/<channelId>가 실채널id를 요구하는 HTTP 계약 자체가 그렇다),
// hasAttachments는 항상 타깃을 defaultConnId로 고정한다(T4 리뷰 C2) — 그리고 resolveDefaultChanId가
// 참조하는 channelsByConn[defaultConnId]와 sendText가 참조하는 chanIdByConnName은 같은 'channels'
// 프레임에서 원자적으로 함께 채워져 항상 일치한다. 즉 "첨부 done인데 그 채널이 chanIdByConnName에
// 없다"는 조합은 현재 렌더러 상태머신에서 구성 불가능하다(addFiles/C2가 이미 막아준다는 뜻 — 좋은
// 일이다). 그래도 버퍼 객체 구조 자체(attachmentIds가 flush까지 살아남는지)는 정확해야 하고, 이걸
// 컴포넌트 안에 둔 채로는 그 정확성을 직접 단위 테스트할 방법이 없어 순수 함수로 뽑았다 — App.tsx의
// onFrame 'channels' 분기가 이 함수 하나로 판정한다(동작 변경 없음, 리팩터만).
export function matchPendingFlush(
  pending: { name: string; mode: string; text: string; attachmentIds?: string[] } | undefined,
  list: { id: string; name: string; mode?: string }[],
): { channelId: string; text: string; attachmentIds?: string[] } | null {
  if (!pending) return null;
  const chan = list.find((c) => c.name === pending.name && (c.mode ?? 'chat') === pending.mode);
  return chan ? { channelId: chan.id, text: pending.text, attachmentIds: pending.attachmentIds } : null;
}

// Task 4(chat-attachments) — 스펙 상한(코드 상수, 서버 attachment-store.ts와 같은 값을 렌더러 쪽에도
// 독립 보유 — renderer는 src/edge를 참조할 수 없는 별도 tsconfig 스코프라 공유 불가, 값만 맞춘다).
const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

// 전송 전 칩 1개의 클라 로컬 상태. id는 업로드 성공 후 서버가 발급한 첨부 id(send 프레임에 실림).
// T4 리뷰 C2: connId·channelId는 "첨부 시점"의 업로드 대상(서버의 AttachmentStore가 실제로 그 첨부를
// 들고 있는 곳)을 고정한다 — 채널/기본 연결을 바꾼 뒤 보내면 이 바인딩과 전송 대상이 달라져 서버가
// 조용히 무시(파일 유실)하므로, 바인딩이 바뀌면 칩을 통째로 비우고(아래 이펙트) doneAttachmentIds도
// 현재 바인딩과 일치하는 것만 골라 보낸다(벨트).
interface PendingAttachment {
  localId: string; file: File; name: string; mime: string; size: number;
  status: 'uploading' | 'done' | 'error'; id?: string;
  connId: string; channelId: string;
}

export default function App() {
  const [connState, setConnState] = useState(() => loadConnections());
  useEffect(() => { saveConnections(connState); }, [connState]);

  const [channelsByConn, setChannelsByConn] = useState<Record<string, Channel[]>>({});
  const [chanIdByConnName, setChanIdByConnName] = useState<Map<string, string>>(new Map());
  const [msgsByConnCh, setMsgsByConnCh] = useState<Map<string, Msg[]>>(new Map());
  const [currentName, setCurrentName] = useState<string | null>(null);
  const [mode, setMode] = useState<'chat' | 'code' | 'team' | 'wiki' | 'admin'>('chat');
  const [awaiting, setAwaiting] = useState<Set<string>>(new Set()); // 키=논리 채널 이름
  // Task 2(brain-activity) — awaiting 중 실시간 라벨(activity 프레임, 휘발). 키=논리 채널 이름(awaiting과
  // 동일 키 공간) — 'msg' 프레임의 기존 name 역조회(connId+channelId→논리 이름)와 같은 방식으로 채운다.
  // 없으면(아직 activity 안 옴/이미 클리어됨) 렌더 쪽이 T.thinking(기본 문구)으로 폴백한다.
  const [activityLabels, setActivityLabels] = useState<Map<string, string>>(new Map());
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [palFilter, setPalFilter] = useState<string | null>(null); // null=닫힘
  const [palIdx, setPalIdx] = useState(0);                          // 선택 인덱스(방향키)
  const [inputText, setInputText] = useState('');                   // 입력값 미러(@ 자동완성 필터용 — input은 여전히 비제어)
  const [mentionIdx, setMentionIdx] = useState(0);                  // @ 자동완성 선택 인덱스(방향키)
  const [showManage, setShowManage] = useState(false);              // Manage Engrams 모달
  const [errText, setErrText] = useState<Record<string, string>>({}); // connId → 최근 에러(연결별 — 서로 안 덮어씀)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Task 4(chat-attachments) — 전송 전 칩(입력창 위, 목업 A). 스레드 답장 입력창엔 없음(브리프 스코프=#inputbar).
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachNotice, setAttachNotice] = useState<string | null>(null); // 상한 초과 안내(칩 단계 차단)
  const fileInputRef = useRef<HTMLInputElement>(null);
  // T4 리뷰 미너 ⑤ — addFiles의 상한(room) 계산은 이 ref(최신값)로 한다. 렌더 본문에서 매번 최신
  // pendingAttachments로 동기화하고(다른 ref 미러들과 같은 패턴), addFiles 안에서 칩을 추가한 직후에도
  // 즉시 갱신해 같은 tick에 addFiles가 연속 호출돼도(드롭+붙여넣기 연타 등) 상한을 정확히 지킨다.
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]); pendingAttachmentsRef.current = pendingAttachments;
  const [wikiPages, setWikiPages] = useState<WikiPageMeta[]>([]);
  const [wikiOpen, setWikiOpen] = useState<WikiPageDto | null>(null);
  const [proposals, setProposals] = useState<ProposalDto[]>([]);
  const [wikiResults, setWikiResults] = useState<WikiSearchHit[]>([]);
  const [adminUsers, setAdminUsers] = useState<AdminUserDto[]>([]);
  const [adminSettings, setAdminSettings] = useState<AdminSettings | null>(null);
  // Phase 16c — 비공개 채널 멤버 관리(주인 전용, 기본 연결의 실제 채널 대상).
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [membersFor, setMembersFor] = useState<string | null>(null); // 관리 중인 실제 채널 id(기본 연결)
  // Task 4 — 채널별 두뇌 드롭다운 채우기용 등록 이름 목록. wiki/admin과 같은 결로 기본 연결
  // (그 서버) 기준 하나만 들고 있는다 — respondMode 팬아웃과 동형으로 다른 연결에도 그대로 전송된다.
  const [brainNames, setBrainNames] = useState<string[]>([]);
  // Task 4(리뷰 지적) — 현재 기본 두뇌 이름(드롭다운 기본 항목의 "Default (claude)" 표시용).
  // brainNames와 같은 결로 기본 연결 기준 하나만.
  const [defaultBrain, setDefaultBrain] = useState<string>('');
  // Phase 16a — 로그인 게이트(기본 연결 기준). meByConn=연결별 로그인한 사용자, gateStatus=그 연결의
  // /auth/status(null=무인증 서버·brain → 게이트 없음, 현행 동작 유지).
  const [meByConn, setMeByConn] = useState<Record<string, UserDto>>({});
  const [gateStatus, setGateStatus] = useState<AuthStatus | null>(null);
  const [gateError, setGateError] = useState<string | undefined>();
  const [gateNotice, setGateNotice] = useState<string | undefined>();
  const awaitTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const msgsRef = useRef<HTMLDivElement>(null);
  // Task 4(clear-compact) — /clear 실행취소 토스트(목업 ③: ~6초, 만료/다음 clear면 백업 확정 삭제).
  // 채널당 1건(연결+채널id)만 들고 있는다 — clearHistory는 항상 기본 연결로만 보내므로 그걸로 충분.
  const [clearToast, setClearToast] = useState<{ connId: string; channelId: string } | null>(null);
  const clearToastRef = useRef<{ connId: string; channelId: string } | null>(null); clearToastRef.current = clearToast;
  const clearToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ★진행 중인 clear를 동기적으로 추적(리뷰 지적): 토스트(clearToast)는 historyCleared 왕복 후에야 세팅되므로,
  // 그 전에 다른 채널을 또 clear하면 이전 백업을 확정하지 못해 orphan+undo 소실. runClear에서 즉시 세팅한다.
  const pendingClearRef = useRef<{ connId: string; channelId: string } | null>(null);

  // 최신 값을 ref로도 들고 있는다(chat.html/Phase11의 currentRef 패턴) — WS 이벤트 콜백이
  // React 커밋 사이 타이밍에서도 항상 "마지막 렌더 기준 최신값"을 읽게 하기 위함.
  const currentNameRef = useRef<string | null>(null); currentNameRef.current = currentName;
  const chanIdByConnNameRef = useRef(chanIdByConnName); chanIdByConnNameRef.current = chanIdByConnName;
  const msgsByConnChRef = useRef(msgsByConnCh); msgsByConnChRef.current = msgsByConnCh;
  const channelsByConnRef = useRef(channelsByConn); channelsByConnRef.current = channelsByConn;
  const modeRef = useRef(mode); modeRef.current = mode;
  const wikiOpenRef = useRef<WikiPageDto | null>(null); wikiOpenRef.current = wikiOpen;
  const wikiQueryRef = useRef(''); // 현재 검색어(늦은 wikiResults 응답 에코 대조용)

  // 채널 생성→전송 2스텝 대기 버퍼: 연결당(target connId) 대기 전송 1건.
  // ponytail: 이름+모드 키 — 그 연결의 channels 프레임이 그 이름+모드를 갖고 돌아오면 flush
  // (모드를 안 보면 동명·타모드 채널로 잘못 flush될 수 있다 — Minor #4).
  // 최종 재리뷰 minor(T4) — attachmentIds도 같이 버퍼링한다. 지연 생성 채널(첫 메시지가 아직 없는
  // 채널)에 첨부와 함께 보내면 createChannel 왕복 후 flush되는데, 여기 안 실으면 텍스트만 나가고
  // 첨부는 조용히 유실된다(그 사이 sendText는 이미 성공 취급해 칩을 비웠으므로 사용자는 눈치 못 챈다).
  const pendingSendRef = useRef<Map<string, { name: string; mode: string; text: string; attachmentIds?: string[] }>>(new Map());

  function onFrame(connId: string, f: ServerFrame) {
    if (f.t === 'channels') {
      setChannelsByConn((prev) => ({ ...prev, [connId]: f.list }));
      // Task 4 — 두뇌 드롭다운은 기본 연결(그 서버) 기준 하나만(roster/wiki와 같은 결).
      if (connId === connState.defaultConnId) { setBrainNames(f.brainNames); setDefaultBrain(f.defaultBrain); }
      setChanIdByConnName((prev) => {
        const next = new Map(prev);
        // Minor: 이 연결의 기존 엔트리를 먼저 지우고 새로 채운다 — 삭제된 채널이 stale로 안 남게.
        for (const key of next.keys()) if (key.startsWith(`${connId}::`)) next.delete(key);
        for (const c of f.list) next.set(chanKey(connId, c.mode ?? 'chat', c.name), c.id);
        return next;
      });
      const flush = matchPendingFlush(pendingSendRef.current.get(connId), f.list);
      if (flush) {
        send(connId, { t: 'send', channelId: flush.channelId, text: flush.text, attachments: flush.attachmentIds });
        pendingSendRef.current.delete(connId);
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
          // Task 2(brain-activity) — 답 도착 시 그 채널의 활동 라벨도 같이 지운다(다음 대기는 기본 문구부터).
          setActivityLabels((prev) => { if (!prev.has(name)) return prev; const n = new Map(prev); n.delete(name); return n; });
        }
      }
    } else if (f.t === 'activity') {
      // Task 2(brain-activity) — 휘발 프레임(저장 안 됨): 그 채널이 지금 awaiting 중일 때만 라벨을 반영한다.
      // 이미 답이 와서 awaiting이 풀렸으면(=늦게 도착한 프레임) 조용히 무시 — 회귀 0(activity 미구독 시
      // awaiting도 어차피 안 켜져 있으므로 이 분기 자체가 아무 효과 없음).
      const name = channelsByConnRef.current[connId]?.find((c) => c.id === f.channelId)?.name;
      if (name && awaiting.has(name)) {
        setActivityLabels((prev) => new Map(prev).set(name, f.label));
      }
    } else if (f.t === 'historyCleared') {
      // Task 4(clear-compact) — 그 채널 transcript를 즉시 비우고(모달·시스템 메시지 없음) 실행취소 토스트를 띄운다.
      setMsgsByConnCh((prev) => new Map(prev).set(`${connId}::${f.channelId}`, []));
      if (clearToastTimer.current) clearTimeout(clearToastTimer.current);
      // 확정 대상을 실제 clear된 (connId,channelId)로 동기화(드롭/확정이 정확한 백업을 가리키게).
      pendingClearRef.current = { connId, channelId: f.channelId };
      setClearToast({ connId, channelId: f.channelId });
      clearToastTimer.current = setTimeout(() => dismissClearToast(true), 6000); // ~6초 뒤 백업 확정 삭제
    } else if (f.t === 'historyRestored') {
      // undoClear 성공 — 서버가 백업을 되돌렸다. 캐시를 그 채널의 실제 기록으로 재동기화하고 토스트를 끈다
      // (drop=false: 이미 되돌려졌으니 dropClearBackup을 보내면 안 됨).
      send(connId, { t: 'history', channelId: f.channelId });
      dismissClearToast(false);
    } else if (f.t === 'compacted') {
      // 서버가 이미 요약→위키 게시→정리를 끝내고 요약 메시지를 append했다 — 재로드하면 그대로 보인다.
      send(connId, { t: 'history', channelId: f.channelId });
    } else if (f.t === 'authOk') {
      setMeByConn((prev) => ({ ...prev, [connId]: f.user }));
    } else if (f.t === 'authErr') {
      setSessions(clearSessionFor(connId)); // 만료/철회된 세션 → 지우고 게이트로 돌려보낸다
      setErrText((prev) => ({ ...prev, [connId]: T.authFailed }));
    } else if (f.t === 'error') {
      console.warn('server error:', f.text);
      setErrText((prev) => ({ ...prev, [connId]: f.text }));
    } else if (connId === connState.defaultConnId) {
      // 위키/제안 프레임 — 위키는 기본 연결(그 서버)로만 스코프된다(팀 채널과 동일한 원칙).
      if (f.t === 'wikiPages') {
        setWikiPages(f.list);
        // 다른 사용자가 내가 열람 중인 페이지를 삭제하면 목록에서 사라진다 — 열람도 비워 stale 문서 방지.
        const open = wikiOpenRef.current;
        if (open && !f.list.some((p) => p.slug === open.slug)) setWikiOpen(null);
      }
      else if (f.t === 'wikiPage') setWikiOpen(f.page);
      else if (f.t === 'wikiResults') { if (f.query === wikiQueryRef.current) setWikiResults(f.list); }
      else if (f.t === 'proposals') setProposals(f.list);
      else if (f.t === 'wikiChanged') {
        send(connState.defaultConnId, { t: 'wikiList' });
        const open = wikiOpenRef.current;
        if (open) send(connState.defaultConnId, { t: 'wikiGet', slug: open.slug });
      }
      else if (f.t === 'proposalsChanged') send(connState.defaultConnId, { t: 'proposalsList' });
      else if (f.t === 'adminUsers') setAdminUsers(f.list);
      else if (f.t === 'adminSettings') setAdminSettings(f.settings);
      else if (f.t === 'roster') setRoster(f.list);
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

  const [sessions, setSessions] = useState<Record<string, string>>(() => loadSessions());
  const { send, statusById } = useConnections(connState.connections, sessions, onFrame, onOpen);

  // team은 기본 연결(그 서버) 하나로 스코프. Ask/Code는 원본 그대로(무변경).
  const viewConns = useMemo(
    () => scopedConnections(connState.connections, mode, connState.defaultConnId),
    [connState.connections, mode, connState.defaultConnId],
  );
  const viewChannelsByConn = useMemo(
    () => scopedChannels(channelsByConn, mode, connState.defaultConnId),
    [channelsByConn, mode, connState.defaultConnId],
  );

  // wiki 모드 진입 시 기본 연결로 목록·제안함을 요청(위키는 채널 개념이 없어 history 패턴 대신 직접 요청).
  useEffect(() => {
    if (mode !== 'wiki') return;
    const id = connState.defaultConnId;
    if (!statusById[id]) return;
    send(id, { t: 'wikiList' });
    send(id, { t: 'proposalsList' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, connState.defaultConnId, statusById[connState.defaultConnId]]);

  // admin 모드 진입 시 기본 연결로 멤버 목록·설정을 요청(wiki useEffect와 동형).
  useEffect(() => {
    if (mode !== 'admin') return;
    const id = connState.defaultConnId;
    if (!statusById[id]) return;
    send(id, { t: 'adminUsers' });
    send(id, { t: 'adminGetSettings' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, connState.defaultConnId, statusById[connState.defaultConnId]]);

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
    const names = logicalChannels(viewChannelsByConn, mode);
    setCurrentName((cur) => (cur && names.includes(cur) ? cur : (names[0] ?? null)));
  }, [viewChannelsByConn, mode]);

  // currentName이 정해지거나(최초 선택 포함) 어느 연결의 channels 목록이 갱신될 때마다,
  // 그 이름 채널을 가진 모든 연결 중 아직 기록이 없는 곳에 history를 요청(둘 다에서 동시에 커버).
  useEffect(() => {
    if (!currentName) return;
    for (const c of viewConns) {
      const chanId = chanIdByConnName.get(chanKey(c.id, mode, currentName));
      if (chanId && !msgsByConnCh.has(`${c.id}::${chanId}`)) {
        send(c.id, { t: 'history', channelId: chanId });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentName, mode, viewChannelsByConn]);

  // 새 메시지/채널 전환/생각중 변화 시 맨 아래로(chat.html box.scrollTop=scrollHeight 이전).
  const mergedMsgs = useMemo(() => {
    if (!currentName) return [] as Msg[];
    const parts = viewConns
      .map((c) => {
        const chanId = chanIdByConnName.get(chanKey(c.id, mode, currentName));
        if (!chanId) return null;
        return { connId: c.id, messages: msgsByConnCh.get(`${c.id}::${chanId}`) ?? [] };
      })
      .filter((x): x is { connId: string; messages: Msg[] } => x !== null);
    return mergeThreads(parts);
  }, [currentName, mode, viewConns, chanIdByConnName, msgsByConnCh]);

  // Task 5 — 질문 카드(m.question)당 그 카드를 참조(answersId===카드.id)하는 답 메시지의 text.
  // 있으면 그 카드는 answered로 렌더된다(QuestionCard로 answeredText prop 전달, Thread가 중개).
  const answeredById = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of mergedMsgs) if (x.answersId) m.set(x.answersId, x.text);
    return m;
  }, [mergedMsgs]);

  // anchor(및 답)의 소유 연결 — 스레드 답글을 그 스레드를 연 Engram으로 라우팅하는 데 쓰인다.
  const anchorConn = useMemo(() => {
    const m = new Map<string, string>();
    if (!currentName) return m;
    for (const c of viewConns) {
      const chanId = chanIdByConnName.get(chanKey(c.id, mode, currentName));
      if (!chanId) continue;
      for (const msg of msgsByConnCh.get(`${c.id}::${chanId}`) ?? []) m.set(msg.id, c.id);
    }
    return m;
  }, [currentName, mode, viewConns, chanIdByConnName, msgsByConnCh]);

  // Task 4(chat-attachments) — 메시지 id → 그 메시지가 실린 연결의 첨부 fetch 정보(엔드포인트·실
  // 채널id·세션 토큰). anchorConn과 같은 이디엄으로 메시지별 소유 연결을 되짚어 계산한다(Message.tsx로
  // Thread를 거쳐 전달). 채널id/엔드포인트를 못 구하면 undefined(Message는 로딩 상태로 남는다).
  const attachmentCtxFor = (msgId: string): AttachmentCtx | undefined => {
    const connId = anchorConn.get(msgId);
    if (!connId || !currentName) return undefined;
    const channelId = chanIdByConnName.get(chanKey(connId, mode, currentName));
    const endpoint = connState.connections.find((c) => c.id === connId)?.endpoint;
    if (!channelId || !endpoint) return undefined;
    return { endpoint, channelId, token: sessions[connId] };
  };

  useEffect(() => {
    const box = msgsRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [currentName, mergedMsgs, awaiting]);

  // 사이드바용 논리 채널 목록(기존 Channels 컴포넌트는 id 기반 — 여기선 id=name으로 합성).
  // wiki 모드엔 채널 개념이 없다(실제 c.mode==='wiki'인 채널은 존재하지 않음) — 그때는 빈 목록.
  const sidebarChannels: Channel[] = mode === 'wiki' || mode === 'admin' ? [] : logicalChannels(viewChannelsByConn, mode).map((name) => {
    const fromDefault = viewChannelsByConn[connState.defaultConnId]?.find((c) => c.name === name && (c.mode ?? 'chat') === mode);
    const any = fromDefault ?? Object.values(viewChannelsByConn).flat().find((c) => c.name === name && (c.mode ?? 'chat') === mode);
    return {
      id: name, name, respondMode: any?.respondMode ?? 'all', mode,
      ...(any?.creatorId ? { creatorId: any.creatorId } : {}),
      ...(any?.visibility ? { visibility: any.visibility } : {}),
      ...(any?.brain ? { brain: any.brain } : {}),
    };
  });
  // Code 영역(헤더/폴더 empty state)은 간단화: 기본 Engram의 그 채널 기준.
  const defaultChan = currentName
    ? channelsByConn[connState.defaultConnId]?.find((c) => c.name === currentName && (c.mode ?? 'chat') === mode)
    : undefined;

  // Task 3(code-panel) — 채널별 열림 탭은 localStorage 퍼시스트(CodePanel.tsx 헬퍼). 채널이 바뀌면
  // 그 채널의 저장된 탭으로, code 모드를 벗어나면 닫힌 것으로 취급한다.
  const [codeTab, setCodeTab] = useState<CodeTab | null>(null);
  useEffect(() => {
    setCodeTab(mode === 'code' && defaultChan?.id ? loadCodeTab(defaultChan.id) : null);
  }, [mode, defaultChan?.id]);
  const openCodeTab = (t: CodeTab) => {
    if (!defaultChan) return;
    setCodeTab(t);
    saveCodeTab(defaultChan.id, t);
  };
  const closeCodePanel = () => {
    if (defaultChan) saveCodeTab(defaultChan.id, null);
    setCodeTab(null);
  };
  const codePanelGate = mode === 'code' && !!defaultChan?.repoPath && !!window.engramDesktop?.ptyStart;

  // 그 이름 채널을 가진 모든 연결에 프레임을 보낸다(삭제·respondMode 변경 팬아웃).
  // team 모드는 스코프된 연결(viewConns=기본 연결 하나)에만 보낸다 — 안 그러면 동명 팀채널이
  // 다른 브레인에도 있을 때 그쪽까지 삭제/변경되어 Phase14가 금지한 교차 연결 오염이 재발한다.
  const fanoutToName = (name: string, build: (channelId: string) => ClientFrame) => {
    const targets = mode === 'team' ? viewConns : connState.connections;
    for (const c of targets) {
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
      setActivityLabels((p) => { if (!p.has(name)) return p; const n = new Map(p); n.delete(name); return n; });
    }, 180000));
    setAwaiting((p) => new Set(p).add(name));
    // Task 2(brain-activity) — 새 대기 시작 시 이전 라벨 잔재를 지운다(다음 activity가 올 때까지 기본 문구).
    setActivityLabels((p) => { if (!p.has(name)) return p; const n = new Map(p); n.delete(name); return n; });
  };

  // 전송 라우팅: threadId 있으면 그 앵커를 연 Engram으로, 없으면 @이름 또는 기본 Engram으로.
  // 대상 연결에 그 이름 채널이 아직 없으면(지연 생성) createChannel 먼저 보내고 1건 버퍼링,
  // 그 연결의 channels 프레임이 그 이름으로 돌아오면 onFrame이 flush한다.
  // Task 5(answersId): 질문 카드 답도 이 경로를 그대로 탄다 — answersId 있으면 send 프레임에 실려
  // 서버가 그 카드를 참조한 답으로 dedup/트리거한다(카드 없는 일반 전송은 기존과 동일, undefined는
  // JSON.stringify가 자동으로 생략).
  // Task 4(chat-attachments): attachmentIds 있으면 라우팅을 기본 연결로 고정한다 — 업로드는 항상
  // 기본 연결의 채널로 보내지므로(아래 addFiles), @멘션 등으로 다른 연결에 보내면 그 연결의
  // AttachmentStore엔 그 id가 없어 서버가 조용히 무시한다(resolveAttachments). 업로드 대상=전송 대상을
  // 항상 일치시켜 이 교차 연결 불일치를 원천 차단한다.
  // 최종 리뷰 지적(Minor): 실패 전송 시 첨부 칩이 조용히 사라지는 문제 — 호출부(Enter/Send)가
  // "프레임이 실제로 나갔는가"를 알아야 성공했을 때만 clearComposerAttachments()를 부를 수 있다.
  // 반환값: 아래 조기 return 경로(텍스트·첨부 둘 다 없음/채널 없음/모드 불가, 미인증 team, 대상
  // 소켓 끊김)는 false — 프레임을 하나도 못 보냈으니 칩을 지우면 업로드가 그냥 유실된다. 그 외
  // (send 프레임 직접 전송, 또는 채널 미생성 시 createChannel 프레임을 보내고 버퍼링)는 true —
  // 기존 호출부(반환값을 무시하던 곳들)는 동작 그대로다.
  const sendText = (text: string, threadId?: string, answersId?: string, attachmentIds?: string[]): boolean => {
    // wiki·admin엔 채널 개념이 없어 currentName이 항상 null이라 이 분기는 실질적으로 도달하지 않는다
    // (mode 가드는 타입 좁히기 겸 방어용).
    const hasAttachments = !!(attachmentIds && attachmentIds.length);
    if ((!text.trim() && !hasAttachments) || !currentName || mode === 'wiki' || mode === 'admin') return false;
    if (mode === 'team' && !meByConn[connState.defaultConnId]) return false; // 미인증 team 전송 차단
    const targetConnId = hasAttachments
      ? connState.defaultConnId
      : threadId
        ? (anchorConn.get(threadId) ?? connState.defaultConnId)
        : mode === 'team'
          ? connState.defaultConnId               // team: @라우팅 안 씀 → @Engram은 멘션으로 전달
          : routeTarget(text, connState.defaultConnId, connState.connections);
    // Minor #5: 대상 연결 소켓이 안 열려 있으면 조용히 버리지 말고 그 연결 에러란에 안내만 남긴다
    // (전송·생각중 타이머 시작은 하지 않는다 — spec §7).
    if (!statusById[targetConnId]) {
      const targetName = connState.connections.find((c) => c.id === targetConnId)?.name ?? targetConnId;
      setErrText((prev) => ({ ...prev, [targetConnId]: T.notConnected(targetName) }));
      return false;
    }
    // authorId는 더 이상 클라가 첨부하지 않는다 — 서버가 인증된 소켓 기준으로 스탬프한다.
    const channelId = chanIdByConnName.get(chanKey(targetConnId, mode, currentName));
    if (channelId) {
      send(targetConnId, { t: 'send', channelId, text, threadId, answersId, attachments: attachmentIds });
    } else if (!threadId) {
      // 최종 재리뷰 minor(T4) — attachmentIds도 같이 버퍼링(위 pendingSendRef 주석 참조).
      pendingSendRef.current.set(targetConnId, { name: currentName, mode, text, attachmentIds });
      send(targetConnId, { t: 'createChannel', name: currentName, mode });
    }
    expectReply(currentName, text, targetConnId);
    return true;
  };

  // Task 4(clear-compact) — 논리 채널 이름 → 기본 연결(그 서버) 기준 실제 채널 id. clear/compact는
  // 항상 기본 연결로만 보낸다(fanoutToName처럼 여러 연결에 팬아웃하지 않는다 — 스펙: send(defaultConnId,...)).
  const resolveDefaultChanId = (name: string): string | undefined =>
    channelsByConn[connState.defaultConnId]?.find((c) => c.name === name && (c.mode ?? 'chat') === mode)?.id;

  // Task 4(chat-attachments) — 업로드 대상은 pa.connId/pa.channelId(첨부 시점에 addFiles가 고정, T4
  // 리뷰 C2). 재시도도 항상 같은 바인딩을 쓴다 — 바인딩이 바뀌면 아래 이펙트가 칩을 통째로 비우므로
  // "바뀐 뒤 재시도"라는 상황 자체가 없다(연결/엔드포인트가 그 사이 삭제됐을 때만 에러로 남는다).
  const uploadOne = (pa: PendingAttachment) => {
    const endpoint = connState.connections.find((c) => c.id === pa.connId)?.endpoint;
    if (!endpoint) {
      setPendingAttachments((prev) => prev.map((p) => (p.localId === pa.localId ? { ...p, status: 'error' } : p)));
      return;
    }
    const token = sessions[pa.connId];
    void uploadAttachment(endpoint, pa.channelId, pa.file, token).then((r) => {
      setPendingAttachments((prev) => prev.map((p) => {
        if (p.localId !== pa.localId) return p;
        return 'error' in r ? { ...p, status: 'error' as const } : { ...p, status: 'done' as const, id: r.id };
      }));
    });
  };

  // 파일 선택(클립 버튼)·붙여넣기(Ctrl+V 스크린샷)·드롭 공용 진입점. 상한 초과분은 업로드하지 않고
  // 안내만 남긴다(브리프: "초과 시 칩 단계에서 안내(전송 차단)"). 통과한 파일만 즉시 칩+업로드 시작 —
  // connId/channelId를 이 시점에 고정해 pa에 싣는다(T4 리뷰 C2: 전송 시점에 다시 계산하면 그 사이
  // 채널/기본 연결이 바뀌었을 때 엉뚱한 곳으로 간다). 채널 자체가 아직 지연 생성 중(resolveDefaultChanId
  // 미해결)이면 조용히 거절 — 에러 칩보다 첨부를 아예 안 받는 편이 덜 헷갈린다(드문 edge case).
  const addFiles = (files: FileList | File[] | null | undefined) => {
    if (!files) return;
    const list = Array.from(files);
    if (!list.length) return;
    const connId = connState.defaultConnId;
    const channelId = currentName ? resolveDefaultChanId(currentName) : undefined;
    if (!channelId) return;
    // T4 리뷰 미너 ⑤ — room은 ref(최신 커밋+같은 tick 갱신분)로 계산한다. pendingAttachments 클로저값
    // 대신 이걸 쓰면 같은 tick에 addFiles가 연속 호출돼도(드롭+붙여넣기 연타 등) 상한을 정확히 지킨다.
    const prevList = pendingAttachmentsRef.current;
    let room = MAX_ATTACHMENTS_PER_MESSAGE - prevList.length;
    let notice: string | null = null;
    const accepted: PendingAttachment[] = [];
    for (const file of list) {
      if (room <= 0) { notice = T.attachTooMany(MAX_ATTACHMENTS_PER_MESSAGE); continue; }
      if (file.size > MAX_ATTACHMENT_BYTES) { notice = T.attachTooLarge(file.name); continue; }
      room--;
      accepted.push({
        localId: `${Date.now()}-${Math.random().toString(36).slice(2)}-${accepted.length}`,
        file, name: file.name, mime: file.type || 'application/octet-stream', size: file.size, status: 'uploading',
        connId, channelId,
      });
    }
    setAttachNotice(notice);
    if (!accepted.length) return;
    const next = [...prevList, ...accepted];
    pendingAttachmentsRef.current = next; // 같은 tick의 다음 addFiles 호출이 이 배치를 바로 보게(벨트)
    setPendingAttachments(next);
    for (const pa of accepted) uploadOne(pa);
  };
  const removeAttachment = (localId: string) => setPendingAttachments((prev) => prev.filter((p) => p.localId !== localId));
  const retryAttachment = (localId: string) => {
    const pa = pendingAttachments.find((p) => p.localId === localId);
    if (!pa) return;
    setPendingAttachments((prev) => prev.map((p) => (p.localId === localId ? { ...p, status: 'uploading' } : p)));
    uploadOne(pa);
  };
  const attachmentsUploading = pendingAttachments.some((p) => p.status === 'uploading');
  const hasErrorAttachment = pendingAttachments.some((p) => p.status === 'error'); // T4 리뷰 I4
  // T4 리뷰 C2(벨트) — 지금 컴포저 바인딩(기본 연결+그 채널)과 정확히 일치하는 칩의 id만 보낸다.
  // 아래 바인딩 변경 이펙트가 보통 이미 칩을 비우지만, 이펙트가 아직 못 돈 찰나(같은 tick)까지 방어.
  const composerChannelId = currentName ? resolveDefaultChanId(currentName) : undefined;
  const doneAttachmentIds = pendingAttachments
    .filter((p) => p.status === 'done' && p.id && p.connId === connState.defaultConnId && p.channelId === composerChannelId)
    .map((p) => p.id as string);
  const clearComposerAttachments = () => { pendingAttachmentsRef.current = []; setPendingAttachments([]); setAttachNotice(null); };

  // T4 리뷰 C2 — 컴포저의 현재 바인딩(기본 연결::채널id). 채널 전환·기본 연결 변경으로 이 값이
  // 바뀌면(칩이 하나라도 있을 때) 첨부 시점 바인딩과 어긋나 서버가 조용히 무시하므로, 칩을 통째로
  // 비우고 안내한다 — 파일 자체는 이미 이전 채널의 AttachmentStore에 남지만(고아, 스펙상 무해) 그
  // 메시지에 실을 방법이 없어져 재첨부를 유도하는 편이 유실보다 낫다.
  const composerBindingKey = `${connState.defaultConnId}::${composerChannelId ?? ''}`;
  const composerBindingRef = useRef(composerBindingKey);
  useEffect(() => {
    if (composerBindingRef.current === composerBindingKey) return;
    composerBindingRef.current = composerBindingKey;
    if (pendingAttachmentsRef.current.length > 0) {
      pendingAttachmentsRef.current = [];
      setPendingAttachments([]);
      setAttachNotice(T.attachChannelChanged);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerBindingKey]);

  // 토스트를 끈다. drop=true면 서버에 dropClearBackup을 보내 백업을 확정 삭제(만료·다음 clear).
  // drop=false는 undoClear/historyRestored처럼 이미 되돌려졌거나 되돌리는 중이라 백업을 지우면 안 될 때.
  const dismissClearToast = (drop: boolean) => {
    if (clearToastTimer.current) { clearTimeout(clearToastTimer.current); clearToastTimer.current = null; }
    // 확정 대상은 pendingClearRef(runClear에서 동기 세팅) — 토스트가 아직 안 떴어도 in-flight clear를 안다.
    const t = pendingClearRef.current;
    if (t && drop) send(t.connId, { t: 'dropClearBackup', id: t.channelId });
    pendingClearRef.current = null;
    setClearToast(null);
  };

  // /clear — 확인창 없이 즉시(스펙 §목업③). 진행 중인 clear가 있으면(토스트가 떴든 왕복 전이든)
  // 그 백업부터 확정 삭제하고 새로 시작한다 — pendingClearRef로 동기 판정(리뷰 지적: clearToastRef는
  // 왕복 후에야 세팅돼 연속 clear에서 이전 채널 백업을 놓쳤다).
  const runClear = (name: string) => {
    const id = resolveDefaultChanId(name);
    if (!id) return;
    const prev = pendingClearRef.current;
    // 다른 채널의 미확정 clear가 있으면 그 백업을 확정 삭제(서버 orphan 방지). 같은 채널이면 서버 clearChannel이
    // 이전 백업을 덮으므로 dropClearBackup 불필요 — 타이머만 리셋해 옛 타이머가 새 백업을 조기 삭제하지 않게.
    if (prev && prev.channelId !== id) send(prev.connId, { t: 'dropClearBackup', id: prev.channelId });
    if (clearToastTimer.current) { clearTimeout(clearToastTimer.current); clearToastTimer.current = null; }
    setClearToast(null);
    pendingClearRef.current = { connId: connState.defaultConnId, channelId: id };
    send(connState.defaultConnId, { t: 'clearHistory', id });
  };
  // /compact — 서버가 요약→위키 게시→정리까지 다 하고 compacted로 알려준다(클라 모달 없음).
  const runCompact = (name: string) => {
    const id = resolveDefaultChanId(name);
    if (!id) return;
    send(connState.defaultConnId, { t: 'compact', id });
  };

  // '/'명령 팔레트에서 클릭·Enter로 명령을 입력창에 채운다(chat.html pickCmd 이전).
  // 'engram' 항목은 텍스트가 아니라 동작(Manage Engrams 모달). clear/compact도 텍스트가 아니라 동작 —
  // 입력창을 채우지 않고(비워서) 곧바로 ws 프레임을 보낸다(스펙: "입력창에 채우지 말고").
  const pickCmd = (insert: string) => {
    setPalFilter(null);
    if (insert === MANAGE_ENGRAMS_INSERT) { setShowManage(true); return; }
    if (insert === CLEAR_INSERT || insert === COMPACT_INSERT) {
      const i = document.getElementById('input') as HTMLInputElement;
      i.value = ''; i.focus(); setInputText('');
      if (currentName) { if (insert === CLEAR_INSERT) runClear(currentName); else runCompact(currentName); }
      return;
    }
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

  // Phase 16a — 로그인 게이트. 기본 연결(defaultConnId)에 저장 세션이 없으면 그 연결의
  // /auth/status를 물어 게이트 표시 여부를 정한다(null=무인증 서버·brain → 게이트 없음).
  // 배포 형태 분리(2026-07-19 설계 §2.2) — localFree(계정 0개+루프백)도 같은 결로 게이트 생략.
  const defId = connState.defaultConnId;
  const defConn = connState.connections.find((c) => c.id === defId);
  useEffect(() => {
    let alive = true;
    setGateStatus(null); setGateError(undefined); setGateNotice(undefined);
    if (!defConn || sessions[defId]) return; // 세션 있으면 게이트 없음(authErr가 오면 위에서 세션이 지워지고 재조회됨)
    void fetchStatus(defConn.endpoint).then((s) => { if (alive) setGateStatus(s?.localFree ? null : s); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defId, defConn?.endpoint, sessions[defId]]);

  const acceptSession = (token: string, user: UserDto) => {
    setSessions(saveSessionFor(defId, token));
    setMeByConn((prev) => ({ ...prev, [defId]: user }));
    setGateStatus(null); setGateError(undefined);
  };
  const handleAuthResult = (r: { token: string; user: UserDto } | { error: string }) => {
    if ('error' in r) setGateError(r.error); else acceptSession(r.token, r.user);
  };
  const startSso = async () => {
    if (!defConn) return;
    const b = await apiOidcBegin(defConn.endpoint);
    if ('error' in b) { setGateError(b.error); return; }
    window.open(b.authUrl, '_blank'); // 데스크톱은 main.ts 핸들러가 기본 브라우저로 연다
    const tick = async (): Promise<void> => {
      const p = await apiOidcPoll(defConn.endpoint, b.pollCode);
      if ('pending' in p) { setTimeout(() => { void tick(); }, 2000); return; }
      handleAuthResult(p);
    };
    void tick();
  };

  // 게이트가 뜨면 앱 본체 대신 게이트만 보여준다(타이틀바는 유지 — 창 드래그·연결 상태 표시는 그대로).
  if (gateStatus && defConn && !sessions[defId]) {
    return (
      <>
        <div id="titlebar"><span id="tbtitle">Engram Desktop</span></div>
        <LoginGate
          connName={defConn.name} status={gateStatus}
          error={gateError} notice={gateNotice}
          onLogin={(l, p) => { void apiLogin(defConn.endpoint, l, p).then(handleAuthResult); }}
          onRegister={(l, p, d) => {
            void apiRegister(defConn.endpoint, l, p, d).then((r) => {
              if ('error' in r) setGateError(r.error);
              else { setGateNotice(T.registered); setGateError(undefined); }
            });
          }}
          onSso={() => { void startSso(); }}
        />
      </>
    );
  }

  return (
    <>
      <div id="titlebar">
        <span id="dot" className={statusById[connState.defaultConnId] ? 'on' : ''} title={errText[connState.defaultConnId] ?? ''} />
        <span id="tbtitle">Engram Desktop</span>
        {meByConn[connState.defaultConnId] && <span id="tbuser">{meByConn[connState.defaultConnId].displayName}</span>}
      </div>
      {showManage && (
        <ManageEngrams
          connections={connState.connections}
          defaultConnId={connState.defaultConnId}
          onAdd={(name, endpoint) => setConnState((s) => addConnection(s, name, endpoint))}
          onRemove={(id) => setConnState((s) => removeConnection(s, id))}
          onSetDefault={(id) => setConnState((s) => setDefault(s, id))}
          onClose={() => setShowManage(false)}
        />
      )}
      <div id="app">
        <Channels
          channels={sidebarChannels} current={currentName} mode={mode}
          canManageChannels={allow(meByConn[connState.defaultConnId], 'channels.manage')}
          myId={meByConn[connState.defaultConnId]?.id}
          onSelect={(name) => setCurrentName(name)} onSetMode={setMode}
          onCreate={(name, m, visibility) => { if (m !== 'wiki' && m !== 'admin') send(connState.defaultConnId, { t: 'createChannel', name, mode: m, ...(visibility ? { visibility } : {}) }); }}
          onDelete={(name) => fanoutToName(name, (id) => ({ t: 'deleteChannel', id }))}
          onSetRespondMode={(name, m) => fanoutToName(name, (id) => ({ t: 'setRespondMode', id, mode: m }))}
          brainNames={brainNames}
          defaultBrain={defaultBrain}
          onSetChannelBrain={(name, brain) => fanoutToName(name, (id) => ({ t: 'setChannelBrain', id, brain }))}
          onClearHistory={(name) => runClear(name)}
          onCompact={(name) => runCompact(name)}
          onManageMembers={(name) => {
            const ch = channelsByConn[connState.defaultConnId]?.find((c) => c.name === name && (c.mode ?? 'chat') === mode);
            if (ch) { setMembersFor(ch.id); send(connState.defaultConnId, { t: 'channelRoster' }); }
          }}
          showAdmin={meByConn[connState.defaultConnId]?.role === 'owner'}
        />
        {membersFor && (() => {
          const ch = channelsByConn[connState.defaultConnId]?.find((c) => c.id === membersFor);
          if (!ch) return null;
          return (
            <ChannelMembers
              roster={roster}
              memberIds={ch.memberIds ?? []}
              creatorId={ch.creatorId}
              visibility={ch.visibility ?? 'public'}
              onSetMembers={(memberIds) => send(connState.defaultConnId, { t: 'setChannelMembers', id: ch.id, memberIds })}
              onSetVisibility={(v) => send(connState.defaultConnId, { t: 'setChannelVisibility', id: ch.id, visibility: v })}
              onClose={() => setMembersFor(null)}
            />
          );
        })()}
        <div id="main">
          {mode === 'admin' ? (
            <AdminArea
              users={adminUsers}
              settings={adminSettings}
              onApprove={(id) => send(connState.defaultConnId, { t: 'adminApprove', id })}
              onSuspend={(id) => send(connState.defaultConnId, { t: 'adminSuspend', id })}
              onRestore={(id) => send(connState.defaultConnId, { t: 'adminRestore', id })}
              onResetPassword={(id, password) => send(connState.defaultConnId, { t: 'adminResetPassword', id, password })}
              onForceLogout={(id) => send(connState.defaultConnId, { t: 'adminForceLogout', id })}
              onSaveSettings={(s) => send(connState.defaultConnId, { t: 'adminSetSettings', settings: s })}
              onSetPermissions={(id, permissions) => send(connState.defaultConnId, { t: 'adminSetPermissions', id, permissions })}
            />
          ) : mode === 'wiki' ? (
            <WikiArea
              pages={wikiPages}
              openPage={wikiOpen}
              proposals={proposals}
              canApprove={allow(meByConn[connState.defaultConnId], 'wiki.approve')}
              canUnpublish={allow(meByConn[connState.defaultConnId], 'wiki.unpublish')}
              canEdit={allow(meByConn[connState.defaultConnId], 'wiki.edit')}
              canDelete={allow(meByConn[connState.defaultConnId], 'wiki.delete')}
              searchResults={wikiResults}
              onSearch={(query) => { wikiQueryRef.current = query; send(connState.defaultConnId, { t: 'wikiSearch', query }); }}
              onOpenPage={(slug) => send(connState.defaultConnId, { t: 'wikiGet', slug })}
              onApprove={(id) => send(connState.defaultConnId, { t: 'proposalApprove', id })}
              onReject={(id) => send(connState.defaultConnId, { t: 'proposalReject', id })}
              onUnpublish={(slug) => send(connState.defaultConnId, { t: 'wikiUnpublish', slug })}
              onEdit={(slug, body) => send(connState.defaultConnId, { t: 'wikiEdit', slug, body })}
              onDelete={(slug) => { send(connState.defaultConnId, { t: 'wikiDelete', slug }); setWikiOpen(null); }}
            />
          ) : (
            <>
              {currentName && mode === 'code' && defaultChan?.repoPath && (
                codePanelGate ? (
                  // T3 리뷰 Minor 1 — 아이콘 게이트가 열린 경우에만 flex+span 마크업(아이콘 자리 확보).
                  // 게이트가 닫힌 코드 채널(비데스크톱 등)은 아래 else 분기로 기존 마크업 그대로(byte-identical).
                  <div id="chhdr" style={{ display: 'flex' }} title={defaultChan.repoPath}>
                    <span>{'📁 ' + defaultChan.repoPath.split(/[\\/]/).filter(Boolean).pop()}</span>
                    <CodePanelIcons activeTab={codeTab} onSelect={openCodeTab} />
                  </div>
                ) : (
                  <div id="chhdr" style={{ display: 'block' }} title={defaultChan.repoPath}>
                    {'📁 ' + defaultChan.repoPath.split(/[\\/]/).filter(Boolean).pop()}
                  </div>
                )
              )}
              {currentName && mode === 'code' && !defaultChan?.repoPath ? (
                <FolderEmpty onSetRepo={(p) => { if (defaultChan) send(connState.defaultConnId, { t: 'setRepoPath', id: defaultChan.id, repoPath: p }); }} />
              ) : (
                <>
              {/* R2-1(Quiet Library 라운드2) — Claude 스타일 중앙 고정폭 칼럼(760px). 순수 표현용
                  래퍼(핸들러·기존 셀렉터 무영향) — #msgs/#palette/#mention/#inputbar를 감싸 폭을 통일하고,
                  절대배치되는 #palette/#mention/#clearToast의 기준 컨테이너가 되어(position:relative)
                  좁아진 입력창 폭에 맞춰 함께 정렬되게 한다. */}
              {(() => {
                const codeChildren = (
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
                      myName={mode === 'team' ? meByConn[connState.defaultConnId]?.id : undefined}
                      onToggle={(c) => setCollapsed((prev) => { const n = new Set(prev); c ? n.add(m.id) : n.delete(m.id); return n; })}
                      onDraft={(v) => setDrafts((p) => new Map(p).set(m.id, v))}
                      onReply={(text) => { sendText(text, m.id); setDrafts((p) => { const n = new Map(p); n.delete(m.id); return n; }); }}
                      onSend={(text) => sendText(text)}
                      getAnsweredText={(id) => answeredById.get(id)}
                      onAnswer={(text, answersId) => sendText(text, undefined, answersId)}
                      getAttachmentCtx={attachmentCtxFor} />
                  ));
                })()}
                {currentName && awaiting.has(currentName) && (
                  // Task 2(brain-activity) — activity 프레임이 오면 그 라벨로 실시간 치환("생각 중" → "웹
                  // 검색 중 · web_search" 등), 없으면 기존 기본 문구.
                  <div className="typing"><span>{activityLabels.get(currentName) ?? T.thinking}</span><span className="dots" /></div>
                )}
              </div>
              {clearToast && clearToast.connId === connState.defaultConnId && clearToast.channelId === defaultChan?.id && (
                <div id="clearToast">
                  {T.clearedToast}
                  <span className="undo" onClick={() => { send(clearToast.connId, { t: 'undoClear', id: clearToast.channelId }); dismissClearToast(false); }}>
                    {T.undo}
                  </span>
                </div>
              )}
              {palFilter !== null ? (
                <Palette filter={palFilter} selected={palIdx} onPick={pickCmd} />
              ) : (
                <MentionAutocomplete text={inputText} names={mentionNames} selected={mentionIdx} onPick={pickMention} />
              )}
              {/* Task 4(chat-attachments, 목업 A) — 전송 전 칩 줄(입력창 위). 상한 안내는 칩이 없어도(전부
                  거절된 배치) 보여야 하므로 chips.length || notice로 렌더 여부를 판정한다. */}
              {currentName && (pendingAttachments.length > 0 || attachNotice) && (
                <div className="pendingChips">
                  {pendingAttachments.map((pa) => (
                    <span key={pa.localId}
                      className={'attachChip' + (pa.status === 'uploading' ? ' uploading' : pa.status === 'error' ? ' error' : '')}
                      title={pa.status === 'error' ? T.attachRetry : undefined}
                      onClick={() => { if (pa.status === 'error') retryAttachment(pa.localId); }}>
                      <span className="name">{pa.name}</span>
                      <span className="x" title={T.attachRemove} onClick={(e) => { e.stopPropagation(); removeAttachment(pa.localId); }}>×</span>
                    </span>
                  ))}
                  {attachNotice
                    ? <span className="attachNotice">{attachNotice}</span>
                    : hasErrorAttachment && <span className="attachNotice">{T.attachHasError}</span>}
                </div>
              )}
              <div id="inputbar" style={currentName ? undefined : { display: 'none' }}
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer?.files); }}>
                <input ref={fileInputRef} type="file" multiple hidden
                  onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
                <button type="button" className="attachBtn" title={T.attachTitle}
                  onClick={() => fileInputRef.current?.click()}>📎</button>
                <input id="input" type="text" placeholder={T.placeholder}
                  onChange={(e) => {
                    const v = e.target.value;
                    setInputText(v);
                    const open = v.startsWith('/');
                    setPalFilter(open ? v.slice(1).toLowerCase() : null);
                    setPalIdx(0);
                    setMentionIdx(0);
                  }}
                  onPaste={(e) => {
                    const files = e.clipboardData?.files; // Ctrl+V 스크린샷 등은 파일로 온다
                    if (files && files.length) { e.preventDefault(); addFiles(files); }
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
                      // T4 리뷰 I4 — 업로드 완료 전(id 미확정)이거나 실패 칩이 남아있으면 전송 보류
                      // (실패 칩을 조용히 빼고 보내면 사용자가 "첨부됐다"고 착각한다 — 안내(attachHasError)로
                      // 제거/재시도를 유도한다).
                      if (attachmentsUploading || hasErrorAttachment) return;
                      const i = e.target as HTMLInputElement;
                      if (!i.value.trim() && pendingAttachments.length === 0) return; // 텍스트도 첨부도 없음
                      const ids = doneAttachmentIds.length ? doneAttachmentIds : undefined;
                      const sent = sendText(i.value, undefined, undefined, ids); i.value = ''; setInputText('');
                      // Minor 픽스: 프레임이 실제로 나갔을 때만 첨부 칩을 지운다 — 실패(소켓 끊김 등)면
                      // 칩을 남겨 사용자가 재전송/제거를 선택할 수 있게 한다(에러 안내는 sendText가 이미 남김).
                      if (sent) clearComposerAttachments();
                    }
                  }} />
                <EngramSelector
                  connections={connState.connections}
                  defaultConnId={connState.defaultConnId}
                  statusById={statusById}
                  onSetDefault={(id) => setConnState((s) => setDefault(s, id))}
                  onManage={() => setShowManage(true)}
                />
                <button
                  disabled={attachmentsUploading || hasErrorAttachment || (!inputText.trim() && pendingAttachments.length === 0)}
                  onClick={() => {
                    const i = document.getElementById('input') as HTMLInputElement;
                    const ids = doneAttachmentIds.length ? doneAttachmentIds : undefined;
                    const sent = sendText(i.value, undefined, undefined, ids); i.value = ''; setInputText('');
                    if (sent) clearComposerAttachments();
                  }}>{T.send}</button>
              </div>
                </>
                );
                return codePanelGate && codeTab && defaultChan ? (
                  <div className="codeMainRow">
                    <div className="chatCol">{codeChildren}</div>
                    <CodePanel channelId={defaultChan.id} repoPath={defaultChan.repoPath as string} tab={codeTab}
                      onChangeTab={openCodeTab} onClose={closeCodePanel} />
                  </div>
                ) : (
                  <div className="chatCol">{codeChildren}</div>
                );
              })()}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
