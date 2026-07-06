import { ko } from '../config';

export interface Command { insert: string; label: string; desc: string }

const COMMANDS: Command[] = [
  { insert: '상태', label: '상태', desc: ko ? '이 채널의 진행 중/최근 작업 상태' : 'Running/recent tasks in this channel' },
  { insert: 'code ', label: 'code <repo> <goal>', desc: ko ? '레포에 코딩 위임 — 자연어("○○레포에 △△ 해줘")도 됨' : 'Delegate coding to a repo — natural language works too' },
  { insert: 'team ', label: 'team <p1,p2> <question>', desc: ko ? '지정한 페르소나 팀으로 협업' : 'Collaborate with the named persona team' },
  { insert: 'ask ', label: 'ask <question>', desc: ko ? '분류 없이 바로 위키 근거 답변' : 'Direct wiki-grounded answer (skips triage)' },
  { insert: 'schedule ', label: 'schedule <cron> <task>', desc: ko ? '예약 — 자연어("매일 9시에…")도 됨' : 'Schedule — natural language works too' },
  { insert: '예약목록', label: ko ? '예약목록' : '예약목록 (list schedules)', desc: ko ? '이 채널의 예약 보기' : 'List schedules in this channel' },
  { insert: '예약취소 ', label: ko ? '예약취소 <id>' : '예약취소 <id> (cancel)', desc: ko ? '예약 취소' : 'Cancel a schedule' },
  { insert: 'resume ', label: 'resume <projectId>', desc: ko ? '멈춘 코딩 작업 재개' : 'Resume a stopped coding project' },
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
        <div key={c.label} className={'item' + (i === selected ? ' sel' : '')} onClick={() => onPick(c.insert)}>
          <span className="cmd">{c.label}</span>
          <span className="desc">{c.desc}</span>
        </div>
      ))}
    </div>
  );
}
