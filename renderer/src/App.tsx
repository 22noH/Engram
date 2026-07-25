import { useEffect, useMemo, useRef, useState } from 'react';
import type { Channel, ClientFrame, Message as Msg, PermMode, RosterEntry, ServerFrame, UserDto } from '../../shared/protocol';
import { loadConnections, saveConnections, setDefault, addConnection, removeConnection, isLocalEndpoint } from './connections';
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
import { ProgressCard } from './components/ProgressCard';
import { groupProgressRuns } from './progress-run';
import { DockIcons, DockPanel } from './components/dock/DockPanel';
import {
  addTab, defaultLayout, type DockLayout, type DockTool, findPaneByTool, focusedPane, focusPane,
  loadDock, makeTab, saveDock, splitPane, updateTab,
} from './dock/layout';
import { loadPrefs } from './dock/prefs';
import { toNavUrl, urlTitle } from './dock/url';
import { getView } from './dock/views';
import { appendAgentLog, consoleLines, requestConfirm } from './dock/agent-store';
import { runBrowserOp } from './dock/agent-run';
import type { BrowserOp } from '../../shared/browser-ops';
import { EngramSelector } from './components/EngramSelector';
import { RespondModeBadge, ModelBadge, EffortBadge, PermModeBadge } from './components/ComposerBadges';
import { MicButton } from './components/MicButton';
import { GitBranchBar } from './components/GitBranchBar';
import { ManageEngrams } from './components/ManageEngrams';
import { MentionAutocomplete, mentionCandidates } from './components/MentionAutocomplete';
import { WikiArea } from './components/WikiArea';
import { AdminArea } from './components/AdminArea';
import { LoginGate } from './components/LoginGate';
import { CliAuthBanner } from './components/CliAuthBanner';
import { allow } from './permissions';
import type { WikiPageMeta, WikiPageDto, ProposalDto, WikiSearchHit, AdminUserDto, AdminSettings } from '../../shared/protocol';
import { T } from './i18n';

// 다중 연결 키 규약: `${connId}::${channelId}` (원시 메시지), `${connId}::${mode}::${name}` (채널id 매핑
// — 동일 연결에 동명·타모드 채널(예: chat "일반"과 code "일반")이 있어도 충돌 않게 mode로 한정한다).
// 채널은 이름+모드로 식별되는 논리 채널 — 여러 연결이 동명·동모드 채널을 가지면 하나로 합쳐 보인다.
function chanKey(connId: string, mode: string, name: string): string {
  return `${connId}::${mode}::${name}`;
}

// Task 4(여러 줄 입력+생성 중지) — #input(textarea) 오토사이즈: 높이를 'auto'로 리셋한 뒤 scrollHeight로
// 다시 잰다(줄이 줄어들 때도 정확히 축소되게). 실제 렌더 높이의 상한(~6줄)은 theme.css의
// max-height(overflow-y:auto)가 clamp — 여기선 항상 콘텐츠 높이 그대로 설정해도 안전하다.
function autosizeTextarea(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
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
  // Task 4(여러 줄 입력+생성 중지) — stopGeneration 프레임을 보낸 뒤 응답(awaiting 해제) 전까지 중지
  // 버튼을 잠가 중복 프레임을 막는다. 키=논리 채널 이름(awaiting과 같은 키 공간).
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  // Task 2(brain-activity) — awaiting 중 실시간 라벨(activity 프레임, 휘발). 키=논리 채널 이름(awaiting과
  // 동일 키 공간) — 'msg' 프레임의 기존 name 역조회(connId+channelId→논리 이름)와 같은 방식으로 채운다.
  // 없으면(아직 activity 안 옴/이미 클리어됨) 렌더 쪽이 T.thinking(기본 문구)으로 폴백한다.
  const [activityLabels, setActivityLabels] = useState<Map<string, string>>(new Map());
  // 답변 실시간 스트리밍 — awaiting 중 흘러들어오는 답변 증분(delta 프레임, 휘발). 키·수명은 activityLabels와
  // 완전히 동일(같은 키 공간, 같은 클리어 지점). 서버가 보내는 건 증분이라 여기서 이어붙인다. 최종 'msg'가
  // 오면 통째로 버리고 확정 메시지가 그 자리를 대신한다(중복 표시 금지).
  const [streamTexts, setStreamTexts] = useState<Map<string, string>>(new Map());
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
  // 자동 업데이트 배너(사용자 요청 2026-07-24): 새 버전이 다 받아지면 상단에 "업데이트 준비됨 · 재시작" 노출.
  // 데스크톱(engramDesktop)에서만 — 브라우저엔 updateState가 없어 항상 null(배너 미표시).
  const [updateReady, setUpdateReady] = useState<string | null>(null);
  // Task 4 — 채널별 두뇌 드롭다운 채우기용 등록 이름 목록. wiki/admin과 같은 결로 기본 연결
  // (그 서버) 기준 하나만 들고 있는다 — respondMode 팬아웃과 동형으로 다른 연결에도 그대로 전송된다.
  const [brainNames, setBrainNames] = useState<string[]>([]);
  // Task 4(리뷰 지적) — 현재 기본 두뇌 이름(드롭다운 기본 항목의 "Default (claude)" 표시용).
  // brainNames와 같은 결로 기본 연결 기준 하나만.
  const [defaultBrain, setDefaultBrain] = useState<string>('');
  // 전역 기본 권한 모드 — 채널에 permMode가 없을 때 서버가 실제로 적용하는 값(권한 모드 배지 라벨용).
  // defaultBrain과 같은 결로 기본 연결 기준 하나만. 서버가 안 알려주면 undefined(배지는 기존대로 '자동').
  const [defaultPermMode, setDefaultPermMode] = useState<PermMode | undefined>(undefined);
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
      if (connId === connState.defaultConnId) { setBrainNames(f.brainNames); setDefaultBrain(f.defaultBrain); setDefaultPermMode(f.defaultPermMode); }
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
          // 답변 실시간 스트리밍 — 확정 메시지가 왔으니 누적 델타 버퍼는 버린다(같은 답이 두 번 보이면 안 됨).
          setStreamTexts((prev) => { if (!prev.has(name)) return prev; const n = new Map(prev); n.delete(name); return n; });
          // Task 4(여러 줄 입력+생성 중지) — 답(중단 안내 포함)이 왔으니 중지 버튼 잠금도 같이 푼다.
          setStopping((prev) => { if (!prev.has(name)) return prev; const n = new Set(prev); n.delete(name); return n; });
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
    } else if (f.t === 'delta') {
      // 답변 실시간 스트리밍 — activity와 똑같은 휘발 규칙: 그 채널이 지금 awaiting 중일 때만 이어붙인다.
      // 이미 답이 와서 awaiting이 풀렸으면(늦게 도착한 델타) 조용히 무시(잔재가 다음 턴으로 새지 않게).
      const name = channelsByConnRef.current[connId]?.find((c) => c.id === f.channelId)?.name;
      if (name && awaiting.has(name)) {
        setStreamTexts((prev) => new Map(prev).set(name, (prev.get(name) ?? '') + f.text));
      }
    } else if (f.t === 'browserOp') {
      // AI 웹 조작(2단계) — 실제 수행은 handleBrowserOp(아래 정의). never-throw: 실패해도 프레임
      // 루프가 죽으면 안 되고, 두뇌는 결과 프레임이 오지 않으면 타임아웃으로 흡수한다.
      void handleBrowserOp(connId, f).catch(() => {});
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

  // 진행 중 애니메이션 — "지금 실제로 돌고 있는 단계"는 채널의 마지막 메시지가 진행 보고(m.progress)일
  // 때 그것 하나뿐이다. 다단계 작업은 끝날 때(성공·실패·중단 안내) 반드시 진행 표식이 없는 메시지를
  // 게시하므로, 답이 오거나 중지하면 그 순간 마지막 메시지가 바뀌며 애니메이션이 저절로 멈춘다.
  // (awaiting은 여기 못 쓴다 — 코딩·협업은 백그라운드로 돌아 첫 보고가 오는 순간 이미 풀린다.)
  const activeProgressId = useMemo(() => {
    const last = mergedMsgs[mergedMsgs.length - 1];
    return last && last.progress ? last.id : undefined;
  }, [mergedMsgs]);

  // 이미 쓴 버튼 숨기기 — "그 버튼이 요구한 답이 실제로 왔는가"를 저장된 기록만으로 판정한다
  // (렌더러 임시 상태가 아니라 기록 기반이라 새로고침·재접속 후에도 그대로 유지된다).
  //  (1) answersId 상관관계 — 버튼 클릭이 보낸 답이 그 메시지를 가리킨다(질문 카드와 동일 기제).
  //  (2) 옛 기록 폴백 — answersId가 없던 시절의 클릭도 숨긴다: 뒤에 온 사용자 메시지의 text가 액션의
  //      send와 정확히 같으면 그게 그 답이다(서버도 정확히 그 문자열로만 pending을 소비한다).
  // 버튼을 무시하고 다른 말만 한 경우는 숨기지 않는다 — 그때 서버 pending(승인 대기)은 아직 살아 있어
  // 버튼이 여전히 유효하기 때문이다.
  const consumedActionIds = useMemo(() => {
    const out = new Set<string>();
    mergedMsgs.forEach((m, i) => {
      if (!m.actions || m.actions.length === 0) return;
      const sends = new Set(m.actions.map((a) => a.send));
      for (let j = i + 1; j < mergedMsgs.length; j++) {
        const later = mergedMsgs[j];
        if (later.answersId === m.id || (later.authorId !== 'engram' && sends.has(later.text.trim()))) {
          out.add(m.id);
          break;
        }
      }
    });
    return out;
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
      // 입력바 노력 배지가 현재 값을 읽는 자리(코드 채널만 의미 있음 — 미설정이면 서버 기본 high).
      ...(any?.effort ? { effort: any.effort } : {}),
      // 입력바 권한 모드 배지가 읽는 자리(코드 채널만 — 미설정이면 서버가 전역 설정으로 폴백).
      ...(any?.permMode ? { permMode: any.permMode } : {}),
    };
  });
  // 입력바 2행 배지(응답 모드·모델·노력)가 읽는 현재 논리 채널. 사이드바와 같은 합성값을 쓴다
  // (여러 연결에 동명 채널이 있어도 기본 연결 것을 우선, 없으면 아무 연결 것).
  const curChan = currentName ? sidebarChannels.find((c) => c.name === currentName) : undefined;
  // 원격 연결이면 모델·노력 배지를 숨긴다(사용자 명시 요구: 원격은 그 서버 설정을 그대로 따른다).
  // 연결 배지(EngramSelector)는 원격에서도 그대로 보인다.
  const isLocalConn = isLocalEndpoint(connState.connections.find((c) => c.id === connState.defaultConnId)?.endpoint);
  // Code 영역(헤더/폴더 empty state)은 간단화: 기본 Engram의 그 채널 기준.
  const defaultChan = currentName
    ? channelsByConn[connState.defaultConnId]?.find((c) => c.name === currentName && (c.mode ?? 'chat') === mode)
    : undefined;

  // 코드 독 패널(2026-07-25) — 채널별 레이아웃을 localStorage에 퍼시스트(dock/layout.ts). 채널이
  // 바뀌면 그 채널의 저장된 레이아웃으로, code 모드를 벗어나면 닫힌 것으로 취급한다(회귀 0 —
  // 기존 단일 패널 사용자 값은 loadDock이 기본 레이아웃으로 이관한다).
  const [dock, setDock] = useState<DockLayout | null>(null);
  useEffect(() => {
    setDock(mode === 'code' && defaultChan?.id ? loadDock(defaultChan.id) : null);
  }, [mode, defaultChan?.id]);
  const applyDock = (next: DockLayout | null) => {
    setDock(next);
    if (defaultChan) saveDock(defaultChan.id, next);
  };
  // 도구 열기(헤더 아이콘) — 그 도구 칸이 있으면 포커스만, 없으면 지금 칸을 아래로 쪼개 만든다.
  const openDockTool = (tool: DockTool) => {
    if (!defaultChan) return;
    if (!dock) { applyDock(defaultLayout(tool)); return; }
    const existing = findPaneByTool(dock, tool);
    applyDock(existing ? focusPane(dock, existing.id) : splitPane(dock, focusedPane(dock).id, 'col', tool));
  };
  const codePanelGate = mode === 'code' && !!defaultChan?.repoPath && !!window.engramDesktop?.ptyStart;

  // 브라우저 칸에 새 탭으로 주소 하나를 연다(HTML 크게 보기·채팅 링크가 함께 쓴다).
  // 브라우저 칸이 없으면 만들고, 지금 보고 있는 탭이 빈 탭이면 그 자리를 쓴다.
  const openInDockBrowser = (url: string, title?: string) => {
    if (!defaultChan) return;
    let next = dock ?? defaultLayout('browser');
    let browser = findPaneByTool(next, 'browser');
    if (!browser) {
      next = splitPane(next, focusedPane(next).id, 'col', 'browser');
      browser = findPaneByTool(next, 'browser')!;
    }
    const activeTab = browser.tabs.find((t) => t.id === browser!.activeTabId);
    next = activeTab && !activeTab.url
      ? updateTab(next, browser.id, activeTab.id, { url, title: title ?? urlTitle(url) })
      : addTab(next, browser.id, makeTab({ url, title: title ?? urlTitle(url) }));
    applyDock(next);
  };

  // AI 웹 조작(2단계) — 두뇌가 보낸 조작 1건을 이 화면의 <webview>에서 수행하고 결과를 돌려준다.
  //
  // 누가 답하는가: **데스크톱 앱이면서 그 코드 채널을 열고 있는** 클라이언트만. 폰 브라우저 등
  // webview가 없는 클라는 조용히 무시한다(중복 응답 방지 — 먼저 온 답만 채택되지만 애초에 못 하는
  // 클라가 "못 한다"고 답해 진짜 화면의 답을 가로채면 안 된다). 열고 있지 않으면 타임아웃(2분)까지
  // 매달리는 대신 무엇을 해야 하는지 즉시 알려준다.
  const answerBrowserOp = (connId: string, opId: string, r: { ok: boolean; text: string }) => {
    send(connId, { t: 'browserResult', opId, ok: r.ok, text: r.text });
  };
  const handleBrowserOp = async (connId: string, f: { channelId: string; opId: string; op: BrowserOp }) => {
    if (!window.engramDesktop) return; // webview가 없는 클라 — 침묵(다른 클라가 답한다)
    if (!defaultChan || defaultChan.id !== f.channelId || mode !== 'code') {
      answerBrowserOp(connId, f.opId, {
        ok: false,
        text: 'browser error: this code channel is not open in the Engram window — ask the user to open it first',
      });
      return;
    }
    const prefs = loadPrefs();
    const browserPane = dock ? findPaneByTool(dock, 'browser') : null;
    const activeTabId = browserPane?.activeTabId ?? null;
    const activeTab = browserPane?.tabs.find((t) => t.id === activeTabId);
    const result = await runBrowserOp(f.op, {
      channelId: f.channelId,
      view: getView(activeTabId),
      currentUrl: activeTab?.url ?? '',
      prefs: { agentEnabled: prefs.agentEnabled, confirmMode: prefs.confirmMode },
      navigate: (url) => openInDockBrowser(url),
      confirm: (label, url) => requestConfirm(f.channelId, label, url),
      log: (e) => { appendAgentLog(f.channelId, e); },
      consoleLines: () => consoleLines(activeTabId),
      saveShot: async (id) => (await window.engramDesktop?.captureWebview?.(id, 'temp')) ?? null,
    });
    answerBrowserOp(connId, f.opId, result);
  };

  // HTML 인라인 미리보기 "크게 보기" — 채팅 카드의 확대 버튼이 넘긴 HTML을 브라우저 칸의 새 탭으로
  // 띄운다. data: URL은 고유(opaque) 출처라 앱 DOM·스토리지에 닿을 수 없고, 미리보기 파티션이라
  // 앱 세션과도 분리된다. 저장은 되지 않는다(dock/layout.ts가 data: 탭을 퍼시스트에서 제외).
  // 패널을 못 여는 영역(일반 Chat/Team, 비데스크톱)에는 onExpandHtml 자체를 내려주지 않아 카드에서
  // 확대 버튼이 사라진다 — 눌러도 아무 일 없는 버튼을 두지 않는다.
  const expandHtml = (html: string) => {
    openInDockBrowser('data:text/html;charset=utf-8,' + encodeURIComponent(html), 'HTML');
  };

  // 더보기(⋮) "채팅 링크를 이 패널에서 열기" — 켜져 있으면 메시지 속 링크를 외부 브라우저 대신
  // 브라우저 칸의 새 탭으로 연다. 꺼져 있으면(기본) 기존 동작 그대로다(회귀 0).
  const onMsgsClick = (e: React.MouseEvent) => {
    if (!codePanelGate || !loadPrefs().openLinksHere) return;
    const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    const href = a?.getAttribute('href') ?? '';
    if (!/^https?:/i.test(href)) return;
    const url = toNavUrl(href);
    if (!url) return;
    e.preventDefault();
    openInDockBrowser(url);
  };

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

  // Task 4(여러 줄 입력+생성 중지) — 현재 채널의 진행 중 턴을 중지. fanoutToName과 같은 결로 그 이름을
  // 가진 모든 연결의 채널에 보낸다 — 실제로 그 턴을 처리 중인 서버만 반응하고(무턴이면 조용히 무시),
  // 나머지는 no-op이라 안전(다중 연결 동명 채널이라도 실수로 남의 턴을 건드리지 않는다).
  const stopCurrent = () => {
    if (!currentName || stopping.has(currentName)) return; // 중복 클릭 방지(중단 안내 도착 전까지 잠금)
    setStopping((p) => new Set(p).add(currentName));
    // 답변 실시간 스트리밍 — 중지했으면 흐르던 텍스트도 즉시 정리한다(중단 안내 메시지가 확정을 대신한다).
    setStreamTexts((p) => { if (!p.has(currentName)) return p; const n = new Map(p); n.delete(currentName); return n; });
    fanoutToName(currentName, (channelId) => ({ t: 'stopGeneration', channelId }));
  };

  // Esc(생성 중지): 입력창 포커스든 아니든 window 레벨에서 한 번만 처리(팔레트/QuestionCard의 자체
  // Escape 처리와 겹치지 않게 awaiting일 때만 반응). 팔레트가 열려 있으면 #input의 onKeyDown이 먼저
  // 팔레트를 닫고 e.stopPropagation()으로 이 리스너까지 안 번지게 막는다(아래 onKeyDown 참고).
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!currentName || !awaiting.has(currentName)) return;
      stopCurrent();
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentName, awaiting, stopping]);

  // 자동 업데이트 상태 조회+구독(사용자 요청 2026-07-24): mount 시 이미 받아둔 업데이트가 있으면 즉시
  // 배너를, 이후 다운로드 완료 이벤트도 반영. 데스크톱 아닐 땐 updateState가 없어 조용히 no-op.
  useEffect(() => {
    const api = window.engramDesktop;
    if (!api?.updateState) return;
    void api.updateState().then((s) => { if (s.pending) setUpdateReady(s.pending); });
    return api.onUpdateReady?.((version) => setUpdateReady(version));
  }, []);

  // 답을 기대하며 "생각 중" 표시(멘션-전용 채널에서 비멘션이면 안 띄움 — chat.html expectReply 이전).
  const expectReply = (name: string, text: string, connId: string) => {
    const c = channelsByConn[connId]?.find((x) => x.name === name);
    if (c && c.respondMode === 'mention' && !/@engram/i.test(text)) return;
    const prev = awaitTimers.current.get(name); if (prev) clearTimeout(prev);
    awaitTimers.current.set(name, setTimeout(() => {
      awaitTimers.current.delete(name);
      setAwaiting((p) => { const n = new Set(p); n.delete(name); return n; });
      setActivityLabels((p) => { if (!p.has(name)) return p; const n = new Map(p); n.delete(name); return n; });
      setStreamTexts((p) => { if (!p.has(name)) return p; const n = new Map(p); n.delete(name); return n; });
      setStopping((p) => { if (!p.has(name)) return p; const n = new Set(p); n.delete(name); return n; });
    }, 180000));
    setAwaiting((p) => new Set(p).add(name));
    // Task 2(brain-activity) — 새 대기 시작 시 이전 라벨 잔재를 지운다(다음 activity가 올 때까지 기본 문구).
    setActivityLabels((p) => { if (!p.has(name)) return p; const n = new Map(p); n.delete(name); return n; });
    // 답변 실시간 스트리밍 — 새 턴이 시작됐으니 이전 턴의 델타 잔재도 같이 지운다(라벨과 같은 결).
    setStreamTexts((p) => { if (!p.has(name)) return p; const n = new Map(p); n.delete(name); return n; });
    // Task 4(여러 줄 입력+생성 중지) — 새 턴이 시작됐으니 이전 턴의 중지 버튼 잠금 잔재도 지운다.
    setStopping((p) => { if (!p.has(name)) return p; const n = new Set(p); n.delete(name); return n; });
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
      const i = document.getElementById('input') as HTMLTextAreaElement;
      i.value = ''; i.focus(); setInputText(''); autosizeTextarea(i);
      if (currentName) { if (insert === CLEAR_INSERT) runClear(currentName); else runCompact(currentName); }
      return;
    }
    const i = document.getElementById('input') as HTMLTextAreaElement;
    i.value = insert; i.focus(); setInputText(insert); autosizeTextarea(i);
  };

  // '@' 자동완성에서 클릭·Enter로 이름을 고르면 커서 앞 '@토큰'을 '@이름 '으로 치환한다.
  const pickMention = (name: string) => {
    const i = document.getElementById('input') as HTMLTextAreaElement;
    const v = i.value.replace(/(^|\s)@(\S*)$/, (_all, pre: string) => `${pre}@${name} `);
    i.value = v; i.focus(); setInputText(v); autosizeTextarea(i);
  };
  const mentionNames = connState.connections.map((c) => c.name);

  // 음성 입력 결과를 입력창에 "삽입"한다(전송은 하지 않는다 — 사용자가 읽고 고칠 수 있게).
  // 기존 내용이 있으면 공백 하나로 이어붙인다. pickMention과 같은 방식(비제어 textarea + 미러 상태).
  const insertIntoInput = (text: string) => {
    const i = document.getElementById('input') as HTMLTextAreaElement | null;
    if (!i) return;
    const cur = i.value;
    const next = cur.trim() ? `${cur.replace(/\s+$/, '')} ${text}` : text;
    i.value = next; i.focus(); setInputText(next); autosizeTextarea(i);
  };

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
      {updateReady && (
        <div id="updateBanner">
          <span>{T.updateReady(updateReady)}</span>
          <button className="updateBtn" onClick={() => void window.engramDesktop?.installUpdate?.()}>{T.updateRestart}</button>
          <button className="updateDismiss" title={T.close} onClick={() => setUpdateReady(null)}>✕</button>
        </div>
      )}
      {/* CLI 두뇌 로그인 배너 — 업데이트 배너 바로 아래(같은 자리). 조회·구독·표시 판단은 컴포넌트가
          전부 들고 있고(데스크톱 아니면 스스로 null), 둘 다 뜨면 세로로 쌓인다. */}
      <CliAuthBanner />
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
                    <DockIcons layout={dock} onOpenTool={openDockTool} />
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
              <div id="msgs" ref={msgsRef} onClick={onMsgsClick}>
                {(() => {
                  const byAnchor = new Map<string, Msg[]>();
                  for (const m of mergedMsgs) {
                    if (m.threadId) {
                      const list = byAnchor.get(m.threadId);
                      if (list) list.push(m); else byAnchor.set(m.threadId, [m]);
                    }
                  }
                  // 진행 카드(2026-07-25) — 한 실행의 진행 보고들을 카드 하나로 묶는다. 묶는 근거는
                  // 기록에 남은 표식(m.progressRun)뿐이라 재시작 후에도 같은 카드가 복원된다.
                  // 답글이 달린 진행 메시지는 접지 않는다(접으면 그 답글이 화면에서 사라진다).
                  return groupProgressRuns(mergedMsgs.filter((m) => !m.threadId), (m) => byAnchor.has(m.id)).map((item) => (
                    item.kind === 'run' ? (
                      <ProgressCard key={item.id} run={item}
                        running={item.steps.some((s) => s.id === activeProgressId)} />
                    ) : (() => { const m = item.m; return (
                    <Thread key={m.id} anchor={m} replies={byAnchor.get(m.id) ?? []}
                      draft={drafts.get(m.id) ?? ''}
                      collapsed={collapsed.has(m.id)}
                      myName={mode === 'team' ? meByConn[connState.defaultConnId]?.id : undefined}
                      // 스레드는 Team 채널에서만. Chat·Code는 답글이 달린 기존 메시지도 평평하게
                      // 펼쳐 보여주고(기록 유실 없음 — 표시만) 답글 입구도 안 띄운다.
                      threaded={mode === 'team'}
                      onToggle={(c) => setCollapsed((prev) => { const n = new Set(prev); c ? n.add(m.id) : n.delete(m.id); return n; })}
                      onDraft={(v) => setDrafts((p) => new Map(p).set(m.id, v))}
                      onReply={(text) => { sendText(text, m.id); setDrafts((p) => { const n = new Map(p); n.delete(m.id); return n; }); }}
                      // 액션 버튼 클릭은 그 메시지 id를 answersId로 싣는다(질문 카드와 같은 경로) —
                      // 기록에 상관관계가 남아 새로고침 후에도 "이미 쓴 버튼"을 알아볼 수 있고,
                      // 서버가 같은 answersId의 중복 답을 조용히 버려 이중 클릭도 무해해진다.
                      onSend={(text, answersId) => sendText(text, undefined, answersId)}
                      activeProgressId={activeProgressId}
                      isActionsConsumed={(id) => consumedActionIds.has(id)}
                      getAnsweredText={(id) => answeredById.get(id)}
                      onAnswer={(text, answersId) => sendText(text, undefined, answersId)}
                      getAttachmentCtx={attachmentCtxFor}
                      // 완료 보고서 액션 — 코드 채널(데스크톱 패널 가능)에서만. 변경점은 독 Diff 칸을
                      // 열고, PR은 기존 [PR 생성] 경로(확인 대화 포함)를 그대로 탄다.
                      onShowDiff={codePanelGate ? () => openDockTool('diff') : undefined}
                      reportRepoPath={defaultChan?.repoPath}
                      onExpandHtml={codePanelGate ? expandHtml : undefined} />
                  ); })()));
                })()}
                {currentName && awaiting.has(currentName) && (() => {
                  // Task 2(brain-activity) — activity 프레임이 오면 그 라벨로 실시간 치환("생각 중" → "웹
                  // 검색 중 · web_search" 등), 없으면 기존 기본 문구.
                  const label = activityLabels.get(currentName);
                  const streamed = streamTexts.get(currentName) ?? '';
                  const typing = <div className="typing"><span>{label ?? T.thinking}</span><span className="dots" /></div>;
                  // 답변 실시간 스트리밍(목업 승인) — 델타가 하나라도 왔으면 "생각 중" 자리에 흐르는 답변
                  // 텍스트 + 깜빡이는 커서를, 그 아래에 도구 활동 줄을 같이 보여준다. 델타가 없으면 기존
                  // 인디케이터 그대로(회귀 0 — delta 프레임을 안 보내는 서버/어댑터는 이 분기에 못 들어온다).
                  // 본문은 평문(pre-wrap)으로 그린다: 미완성 마크다운을 조각마다 파싱하면 코드펜스·표가
                  // 열렸다 닫혔다 하며 깜빡인다. 확정 메시지(Message)가 마크다운 렌더를 담당한다.
                  if (!streamed) return typing;
                  return (
                    <div className="msg streaming">
                      <div className="who">{T.engram}</div>
                      <div className="body">{streamed}<span className="caret" /></div>
                      {label && typing}
                    </div>
                  );
                })()}
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
              {/* 코드 채널 상단 줄(B안, 목업 승인) — 입력바 바로 위 별도 줄. 데스크톱+repoPath일 때만.
                  refreshKey=메시지 수: 두뇌가 답(=커밋/수정)을 낼 때마다 다시 읽는다(폴링 없음). */}
              {mode === 'code' && defaultChan?.repoPath && window.engramDesktop?.gitBranchStatus && (
                <GitBranchBar repoPath={defaultChan.repoPath} refreshKey={mergedMsgs.length} />
              )}
              <div id="inputbar" style={currentName ? undefined : { display: 'none' }}
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer?.files); }}>
                <input ref={fileInputRef} type="file" multiple hidden
                  onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
                {/* 입력바 2줄 개편(목업 승인 2026-07-25) — 1행: 입력+↵ 힌트 / 2행: 도구 줄.
                    기존 입력 동작(오토사이즈·Enter 전송·Shift+Enter·IME 가드·팔레트/멘션)은 전부 그대로다. */}
                <div className="composerRow">
                {/* Task 4(여러 줄 입력+생성 중지, 목업 승인) — input→textarea. rows=1 시작, onChange마다
                    autosizeTextarea로 scrollHeight까지 키우고(최대 ~6줄은 theme.css max-height가 clamp).
                    Enter(시프트 없음·팔레트/멘션 닫힘)=전송, Shift+Enter=줄바꿈(네이티브 기본 동작에 기대지
                    않고 직접 삽입 — jsdom 등 합성 keydown 환경에서도 동일하게 동작하도록). */}
                <textarea id="input" rows={1} placeholder={T.placeholder}
                  onChange={(e) => {
                    const v = e.target.value;
                    setInputText(v);
                    const open = v.startsWith('/');
                    setPalFilter(open ? v.slice(1).toLowerCase() : null);
                    setPalIdx(0);
                    setMentionIdx(0);
                    autosizeTextarea(e.target);
                  }}
                  onPaste={(e) => {
                    const files = e.clipboardData?.files; // Ctrl+V 스크린샷 등은 파일로 온다
                    if (files && files.length) { e.preventDefault(); addFiles(files); }
                  }}
                  onKeyDown={(e) => {
                    // T4 리뷰(Important) — 한글 등 IME 조합 중 Enter는 "음절 확정" 이벤트다. 이걸 전송·
                    // 줄바꿈·팔레트/멘션 선택으로 가로채면 조합 중이던 마지막 음절이 날아가거나 의도치
                    // 않게 전송/선택돼 버린다. isComposing이 true인 동안(구형 브라우저 폴백으로 keyCode
                    // 229도 같이 본다) Enter는 이 핸들러의 어떤 분기도 타지 않고 그대로 통과시켜 IME가
                    // 스스로 확정 처리하게 둔다 — preventDefault도 호출하지 않는다. 팔레트/멘션 선택도
                    // 같은 결로 막는다: 조합 확정 Enter가 팔레트 항목을 잘못 골라버리면 안 되므로 이
                    // 가드를 모든 분기보다 먼저(맨 위) 둔다.
                    if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) return;
                    if (palFilter !== null) { // 팔레트 열림: 방향키/Enter/Esc는 팔레트 조작(전송 아님)
                      const items = filterCommands(palFilter);
                      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); setPalIdx((p) => (p + 1) % items.length); return; }
                      if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); setPalIdx((p) => (p - 1 + items.length) % items.length); return; }
                      if (e.key === 'Enter' && items.length) { e.preventDefault(); pickCmd(items[Math.min(palIdx, items.length - 1)].insert); return; }
                      // 팔레트가 열려 있으면 Esc는 팔레트부터 닫는다 — window 레벨 생성-중지 리스너까지
                      // 이벤트가 안 번지게 stopPropagation(중지는 이 Esc 입력에서 트리거되지 않는다).
                      if (e.key === 'Escape') { e.stopPropagation(); setPalFilter(null); return; }
                    } else { // 팔레트 닫힘: '@' 자동완성 열려 있으면 방향키/Enter는 그쪽 조작
                      const items = mentionCandidates(inputText, mentionNames);
                      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); setMentionIdx((p) => (p + 1) % items.length); return; }
                      if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); setMentionIdx((p) => (p - 1 + items.length) % items.length); return; }
                      if (e.key === 'Enter' && items.length) { e.preventDefault(); pickMention(items[Math.min(mentionIdx, items.length - 1)]); return; }
                    }
                    if (e.key === 'Enter' && e.shiftKey) {
                      // 줄바꿈 삽입 — 커서 위치에 직접 삽입해 네이티브 기본 동작(브라우저마다·테스트 환경마다
                      // 다를 수 있음)에 기대지 않는다.
                      e.preventDefault();
                      const el = e.target as HTMLTextAreaElement;
                      const start = el.selectionStart ?? el.value.length;
                      const end = el.selectionEnd ?? el.value.length;
                      const next = el.value.slice(0, start) + '\n' + el.value.slice(end);
                      el.value = next;
                      el.selectionStart = el.selectionEnd = start + 1;
                      setInputText(next);
                      autosizeTextarea(el);
                      return;
                    }
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      // T4 리뷰 I4 — 업로드 완료 전(id 미확정)이거나 실패 칩이 남아있으면 전송 보류
                      // (실패 칩을 조용히 빼고 보내면 사용자가 "첨부됐다"고 착각한다 — 안내(attachHasError)로
                      // 제거/재시도를 유도한다).
                      if (attachmentsUploading || hasErrorAttachment) return;
                      const i = e.target as HTMLTextAreaElement;
                      if (!i.value.trim() && pendingAttachments.length === 0) return; // 텍스트도 첨부도 없음
                      const ids = doneAttachmentIds.length ? doneAttachmentIds : undefined;
                      const sent = sendText(i.value, undefined, undefined, ids); i.value = ''; setInputText('');
                      autosizeTextarea(i);
                      // Minor 픽스: 프레임이 실제로 나갔을 때만 첨부 칩을 지운다 — 실패(소켓 끊김 등)면
                      // 칩을 남겨 사용자가 재전송/제거를 선택할 수 있게 한다(에러 안내는 sendText가 이미 남김).
                      if (sent) clearComposerAttachments();
                    }
                  }} />
                <span className="enterHint" title={T.enterHint} aria-hidden="true">↵</span>
                </div>
                <div className="composerRow composerTools">
                  <div className="composerLeft">
                    {/* 코드 채널은 이 자리가 "권한 모드"(어디까지 알아서 할지), Chat·Team은 기존 "응답 모드"
                        그대로. 서버는 채널에 값이 없으면 전역 설정으로 폴백하므로 미설정 채널 표시는
                        서버가 알려준 전역 기본값(defaultPermMode)이다 — 모르면 배지가 'auto'로 폴백. */}
                    {mode === 'code' ? (
                      <PermModeBadge
                        permMode={curChan?.permMode}
                        defaultPermMode={defaultPermMode}
                        onChange={(m) => { if (currentName) fanoutToName(currentName, (id) => ({ t: 'setChannelPermMode', id, permMode: m })); }}
                      />
                    ) : (
                      <RespondModeBadge
                        mode={curChan?.respondMode ?? 'all'}
                        onChange={(m) => { if (currentName) fanoutToName(currentName, (id) => ({ t: 'setRespondMode', id, mode: m })); }}
                      />
                    )}
                    <button type="button" className="attachBtn" title={T.attachTitle}
                      onClick={() => fileInputRef.current?.click()}>＋</button>
                    <MicButton onText={insertIntoInput} />
                  </div>
                  <div className="composerRight">
                    <EngramSelector
                      connections={connState.connections}
                      defaultConnId={connState.defaultConnId}
                      statusById={statusById}
                      onSetDefault={(id) => setConnState((s) => setDefault(s, id))}
                      onManage={() => setShowManage(true)}
                    />
                    {/* 모델(채널 두뇌) — 로컬 연결에서만. 원격은 그 서버가 정한 모델을 따른다. */}
                    {isLocalConn && (
                      <ModelBadge
                        brain={curChan?.brain} brainNames={brainNames} defaultBrain={defaultBrain}
                        onChange={(brain) => { if (currentName) fanoutToName(currentName, (id) => ({ t: 'setChannelBrain', id, brain })); }}
                      />
                    )}
                    {/* 노력 — 코드 채널 + 로컬 연결에서만(Chat·Team은 서버가 high로 고정, 원격은 서버 설정). */}
                    {isLocalConn && mode === 'code' && (
                      <EffortBadge
                        effort={curChan?.effort ?? 'high'}
                        onChange={(effort) => { if (currentName) fanoutToName(currentName, (id) => ({ t: 'setChannelEffort', id, effort })); }}
                      />
                    )}
                    {currentName && awaiting.has(currentName) ? (
                      // Task 4(여러 줄 입력+생성 중지) — 대기 중엔 보내기 대신 ■ 중지(danger 아웃라인). 클릭
                      // 즉시 잠가(stopping) 중복 stopGeneration 프레임을 막고, 중단 안내(또는 정상 답) 도착 시
                      // awaiting이 풀리며 자동으로 보내기 버튼으로 되돌아간다(별도 원복 로직 불필요).
                      <button type="button" className="stopBtn" disabled={stopping.has(currentName)} onClick={stopCurrent}>
                        ■ {T.stopGen}
                      </button>
                    ) : (
                      <button
                        disabled={attachmentsUploading || hasErrorAttachment || (!inputText.trim() && pendingAttachments.length === 0)}
                        onClick={() => {
                          const i = document.getElementById('input') as HTMLTextAreaElement;
                          const ids = doneAttachmentIds.length ? doneAttachmentIds : undefined;
                          const sent = sendText(i.value, undefined, undefined, ids); i.value = ''; setInputText('');
                          autosizeTextarea(i);
                          if (sent) clearComposerAttachments();
                        }}>{T.send}</button>
                    )}
                  </div>
                </div>
              </div>
                </>
                );
                return codePanelGate && dock && defaultChan ? (
                  <div className="codeMainRow">
                    <div className="chatCol">{codeChildren}</div>
                    <DockPanel channelId={defaultChan.id} repoPath={defaultChan.repoPath as string}
                      layout={dock} onLayout={applyDock} />
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
