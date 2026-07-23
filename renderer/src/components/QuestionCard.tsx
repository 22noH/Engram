import { useState } from 'react';
import type { QuestionItem } from '../../../shared/protocol';
import { T } from '../i18n';

// 질문 카드(목업 v4) — 두뇌가 게시한 선택지 카드를 렌더하고, Send 시에만 답을 전송한다.
// 클릭/타이핑=선택 표시만(전송 아님), Send=전송 확정, Skip=현재 질문 건너뜀(묶음이면 다음으로).
// 전송 포맷은 항상 `header(없으면 q): 답`을 세그먼트로 두고(단일 질문도 세그먼트 1개), 묶음이면
// 그 세그먼트들을 ' / '로 합친다 — encode/decode 대칭(아래 decodeAnswers)이라 answered 재구성이 쉽다.
// answered 재구성: answeredText(이 카드를 참조하는 답 메시지의 text)를 역파싱해 어떤 옵션이 선택됐는지
// 복원한다(새로고침 등으로 컴포넌트가 처음부터 다시 마운트돼도 로컬 상태 없이 정확히 그린다).

function segmentLabel(q: QuestionItem): string {
  return q.header ?? q.q;
}

// answeredText → 질문별 원답(선택지 라벨들을 ', '로 합친 문자열, multiSelect 아니면 라벨 1개, 기타 입력이면
// 그 텍스트) 배열. 못 찾은(건너뛴) 질문은 null. '(skipped)' 리터럴은 전부 null로.
function decodeAnswers(text: string, questions: QuestionItem[]): (string | null)[] {
  if (text === T.qSkipped) return questions.map(() => null);
  const segments = text.split(' / ');
  return questions.map((q) => {
    const prefix = segmentLabel(q) + ': ';
    const seg = segments.find((s) => s.startsWith(prefix));
    return seg ? seg.slice(prefix.length) : null;
  });
}

export function QuestionCard(props: {
  msgId: string;
  question: { questions: QuestionItem[] };
  answeredText?: string;
  onAnswer: (text: string, answersId: string) => void;
}) {
  const { msgId, question, answeredText, onAnswer } = props;
  const questions = question.questions;
  const answered = answeredText !== undefined;
  const decoded = answered ? decodeAnswers(answeredText!, questions) : null;

  // answered면 마지막 질문(=Send 시점에 화면에 있던 질문)을 보여준다. 진행 중이면 0에서 시작.
  const [idx, setIdx] = useState<number>(() => (answered ? questions.length - 1 : 0));
  const [segments, setSegments] = useState<(string | null)[]>(() => questions.map(() => null));
  const [selectedSet, setSelectedSet] = useState<Set<number>>(new Set());
  const [otherActive, setOtherActive] = useState(false);
  const [otherText, setOtherText] = useState('');

  const q = questions[idx];
  const bundle = questions.length > 1;
  const rawAnswer = decoded ? decoded[idx] : null;

  // 화면에 보여줄 선택 라벨들(라이브=현재 로컬 선택, answered=역파싱 결과).
  const selectedLabels: string[] = answered
    ? (rawAnswer === null ? [] : q.multiSelect ? rawAnswer.split(', ') : [rawAnswer])
    : (() => {
        const arr = [...selectedSet].sort((a, b) => a - b).map((i) => q.options[i].label);
        if (otherActive && otherText.trim()) arr.push(otherText.trim());
        return arr;
      })();
  const optionLabelSet = new Set(q.options.map((o) => o.label));
  const otherLabel = selectedLabels.find((l) => !optionLabelSet.has(l));
  const otherRowChosen = answered ? otherLabel !== undefined : otherActive;
  const otherRowValue = answered ? (otherLabel ?? '') : otherText;

  const currentAnswer = (): string | null => {
    const labels = [...selectedSet].sort((a, b) => a - b).map((i) => q.options[i].label);
    if (otherActive && otherText.trim()) labels.push(otherText.trim());
    return labels.length ? labels.join(', ') : null;
  };

  const finalize = (skip: boolean) => {
    const raw = skip ? null : currentAnswer();
    const next = [...segments];
    next[idx] = raw;
    if (idx === questions.length - 1) {
      const parts = next.map((a, i) => (a === null ? null : `${segmentLabel(questions[i])}: ${a}`));
      const nonNull = parts.filter((p): p is string => p !== null);
      setSegments(next);
      onAnswer(nonNull.length ? nonNull.join(' / ') : T.qSkipped, msgId);
    } else {
      setSegments(next);
      setIdx(idx + 1);
      setSelectedSet(new Set());
      setOtherActive(false);
      setOtherText('');
    }
  };

  const selectOption = (i: number) => {
    if (answered) return;
    if (q.multiSelect) {
      setSelectedSet((p) => { const n = new Set(p); if (n.has(i)) n.delete(i); else n.add(i); return n; });
    } else {
      setSelectedSet(new Set([i]));
      setOtherActive(false);
    }
  };
  const selectOther = () => {
    if (answered) return;
    if (q.multiSelect) setOtherActive((p) => !p);
    else { setSelectedSet(new Set()); setOtherActive(true); }
  };
  const onOtherChange = (v: string) => {
    if (answered) return;
    setOtherText(v);
    if (v.trim()) {
      setOtherActive(true);
      if (!q.multiSelect) setSelectedSet(new Set());
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (answered) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT') { if (e.key === 'Escape') (e.currentTarget as HTMLElement).blur(); return; }
    if (e.key === 'Escape') { (e.currentTarget as HTMLElement).blur(); return; }
    if (e.key === 'Enter') { e.preventDefault(); finalize(false); return; }
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1) {
      const rowCount = q.options.length + 1;
      if (n <= rowCount) { if (n === rowCount) selectOther(); else selectOption(n - 1); }
    }
  };

  return (
    <div className={'qcard' + (answered ? ' answered' : '')} tabIndex={answered ? -1 : 0} onKeyDown={onKeyDown} aria-label={q.q}>
      <div className="qhead">
        <span className="qicon" aria-hidden="true">❓</span>
        <span className="qtext">{q.q}</span>
        {bundle && <span className="qcount">{idx + 1}/{questions.length}</span>}
      </div>
      {q.options.map((o, i) => {
        const chosen = selectedLabels.includes(o.label);
        return (
          <div key={o.label + i} className={'qopt' + (chosen ? ' sel' : '')}
               role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={chosen}
               onClick={() => selectOption(i)}>
            <span className={'qnum' + (chosen || o.recommended ? ' acc' : '')}>{i + 1}</span>
            <div className="qbody">
              <span className="qlabel">
                {answered && chosen && <span className="qcheck">✓</span>} {o.label}
              </span>
              {o.recommended && <span className="qrec">{T.qRecommended}</span>}
              {o.desc && <div className="qdesc">{o.desc}</div>}
            </div>
          </div>
        );
      })}
      <div className={'qopt qother' + (otherRowChosen ? ' sel' : '')} onClick={selectOther}>
        <span className={'qnum' + (otherRowChosen ? ' acc' : '')}>{q.options.length + 1}</span>
        {answered && otherRowChosen && <span className="qcheck">✓</span>}
        <input type="text" placeholder={T.qOtherPh} value={otherRowValue} disabled={answered}
               onClick={(e) => e.stopPropagation()} onChange={(e) => onOtherChange(e.target.value)} />
      </div>
      {!answered && (
        <div className="qfoot">
          <button type="button" className="qskip" onClick={() => finalize(true)}>{T.qSkip}</button>
          <button type="button" onClick={() => finalize(false)}>{T.send}</button>
        </div>
      )}
    </div>
  );
}
