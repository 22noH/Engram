import { ko } from '../config';

export interface Command { insert: string; label: string; desc: string; isNew?: boolean }

// 팔레트에서 고를 수 있지만 "입력창에 채울 텍스트"가 아니라 App이 가로채 처리할 동작(기본 Engram
// 변경 → Manage Engrams 모달 열기). 사용자가 실수로 타이핑할 일 없는 출력 가능한(printable) 문자열 센티널이며,
// App이 이 값과 정확히 동일한지(===)만 비교해 가로챈다(널 문자 아님).
export const MANAGE_ENGRAMS_INSERT = '@@manage-engrams';
// Task 4(clear-compact) — 위와 동일한 센티널 패턴. /clear·/compact는 채팅으로 전송되지 않고
// App이 가로채 ws clearHistory/compact 프레임을 곧바로 보낸다(입력창도 채우지 않는다).
export const CLEAR_INSERT = '@@clear-history';
export const COMPACT_INSERT = '@@compact';

const COMMANDS: Command[] = [
  { insert: '상태', label: '상태', desc: ko ? '이 채널의 진행 중/최근 작업 상태' : 'Running/recent tasks in this channel' },
  { insert: 'code ', label: 'code <repo> <goal>', desc: ko ? '레포에 코딩 위임 — 자연어("○○레포에 △△ 해줘")도 됨' : 'Delegate coding to a repo — natural language works too' },
  { insert: 'team ', label: 'team <p1,p2> <question>', desc: ko ? '지정한 페르소나 팀으로 협업' : 'Collaborate with the named persona team' },
  { insert: 'ask ', label: 'ask <question>', desc: ko ? '분류 없이 바로 위키 근거 답변' : 'Direct wiki-grounded answer (skips triage)' },
  {
    insert: CLEAR_INSERT, label: '/clear', isNew: true,
    desc: ko
      ? '이 채널 대화 기록 삭제 — 컨텍스트·화면 리셋 (되돌리기 불가)'
      : "Delete this channel's history — resets context & screen (irreversible)",
  },
  {
    insert: COMPACT_INSERT, label: '/compact', isNew: true,
    desc: ko
      ? '대화를 요약해 위키에 저장하고 기록 정리 — 요약을 읽어 이어감'
      : 'Summarize this chat to the wiki and clear history — continues from the summary',
  },
  { insert: 'schedule ', label: 'schedule <cron> <task>', desc: ko ? '예약 — 자연어("매일 9시에…")도 됨' : 'Schedule — natural language works too' },
  { insert: '예약목록', label: ko ? '예약목록' : '예약목록 (list schedules)', desc: ko ? '이 채널의 예약 보기' : 'List schedules in this channel' },
  { insert: '예약취소 ', label: ko ? '예약취소 <id>' : '예약취소 <id> (cancel)', desc: ko ? '예약 취소' : 'Cancel a schedule' },
  { insert: 'resume ', label: 'resume <projectId>', desc: ko ? '멈춘 코딩 작업 재개' : 'Resume a stopped coding project' },
  { insert: MANAGE_ENGRAMS_INSERT, label: 'engram', desc: ko ? '기본 Engram 변경 — Manage Engrams 열기' : 'Change the default Engram — opens Manage Engrams' },
];

// filter='/' 뒤 소문자. App이 키보드 네비(ArrowUp/Down+Enter)를 몰려면 필터 결과가 필요 → 여기서 export.
export function filterCommands(filter: string): Command[] {
  return COMMANDS.filter((c) => c.label.toLowerCase().includes(filter) || c.insert.toLowerCase().includes(filter));
}

// '/'로 시작하면 표시. selected(=palIdx)에 .sel 강조(chat.html renderPalette 이전). 클릭·Enter로 insert 채움.
export function Palette({ filter, selected, onPick }: { filter: string; selected: number; onPick: (insert: string) => void }) {
  const items = filterCommands(filter);
  if (items.length === 0) return null;
  return (
    <div id="palette" style={{ display: 'block' }}>
      {items.map((c, i) => (
        <div key={c.label} className={'item' + (i === selected ? ' sel' : '') + (c.isNew ? ' new' : '')} onClick={() => onPick(c.insert)}>
          <span className="cmd">{c.label}</span>
          <span className="desc">{c.desc}</span>
        </div>
      ))}
    </div>
  );
}
