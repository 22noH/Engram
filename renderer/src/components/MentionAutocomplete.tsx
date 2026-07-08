import { T } from '../i18n';

// 순수 필터: 커서 앞 토큰(문자열 끝 기준 — 입력이 한 줄이라 커서는 통상 끝에 있다고 가정,
// Palette.filterCommands의 '/'-접두 가정과 동일한 단순화)이 '@'로 시작하면 그 뒤 글자로
// 시작하는 연결 이름 후보를 반환한다. '@' 앞은 줄 시작이거나 공백이어야(이메일 등과 혼동 방지).
export function mentionCandidates(text: string, names: string[]): string[] {
  const m = text.match(/(?:^|\s)@(\S*)$/);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return names.filter((n) => n.toLowerCase().startsWith(q));
}

// '@' 자동완성 팝오버(Palette와 같은 이디엄). 선택 시 onPick(name) → 호출부가 `@name `으로 치환.
export function MentionAutocomplete({ text, names, selected, onPick }: {
  text: string;
  names: string[];
  selected: number;
  onPick: (name: string) => void;
}) {
  const items = mentionCandidates(text, names);
  if (items.length === 0) return null;
  return (
    <div id="mention" style={{ display: 'block' }}>
      <div className="hint">{T.mentionHint}</div>
      {items.map((n, i) => (
        <div key={n} className={'item' + (i === selected ? ' sel' : '')} onClick={() => onPick(n)}>
          <span className="cmd">{'@' + n}</span>
        </div>
      ))}
    </div>
  );
}
