import { useState } from 'react';
import type { QuestionItem } from '../../../shared/protocol';
import { T } from '../i18n';

// 질문 카드(목업 v4) — 두뇌가 게시한 선택지 카드를 렌더하고, Send 시에만 답을 전송한다.
// 클릭/타이핑=선택 표시만(전송 아님), Send=전송 확정, Skip=현재 질문 건너뜀(묶음이면 다음으로).
// 전송 포맷(T5 리뷰 D1 — 목업 정합): 질문이 1개면 답 그 자체를 그대로 전송(접두어 없음 — 승인된
// 목업의 답 버블이 "General + Research"처럼 순수 답만 보여준다). 묶음(2개 이상)일 때만 각 질문을
// `header(없으면 q): 답` 세그먼트로 감싸 ' / '로 합친다(여러 답을 한 메시지에 실어야 하니 구분자 필요).
// answered 재구성: answeredText(이 카드를 참조하는 답 메시지의 text)를 역파싱해 어떤 옵션이 선택됐는지
// 복원한다(새로고침 등으로 컴포넌트가 처음부터 다시 마운트돼도 로컬 상태 없이 정확히 그린다) — decodeAnswers가
// 인코딩과 대칭이라 단일/묶음 분기도 그대로 반영한다.

function segmentLabel(q: QuestionItem): string {
  return q.header ?? q.q;
}

// answeredText → 질문별 원답(선택지 라벨들을 ', '로 합친 문자열, multiSelect 아니면 라벨 1개, 기타 입력이면
// 그 텍스트) 배열. 못 찾은(건너뛴) 질문은 null. '(skipped)' 리터럴은 전부 null로.
// 단일 질문이면 접두어가 없으므로(위 인코딩 규칙) 텍스트 자체가 곧 그 질문의 답 — 파싱할 게 없다.
// 묶음일 때만 'header: 답' 접두어로 세그먼트를 찾는다 — header(또는 q)에 ": "가 우연히 들어있으면
// 오매칭 가능성이 있는 best-effort 파싱(질문 헤더는 짧은 라벨이라 실사용에서 발생 가능성 낮음, 브리프 미요구).
function decodeAnswers(text: string, questions: QuestionItem[]): (string | null)[] {
  if (text === T.qSkipped) return questions.map(() => null);
  if (questions.length === 1) return [text];
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
  // T5 리뷰 미너 #2 — 서버 echo(answeredText prop)가 돌아오기 전 이중클릭으로 onAnswer가 두 번
  // 나가는 것을 막는 로컬 가드(서버측 dedup이 진짜 방어선, 이건 그 전까지 UI를 즉시 무동작으로).
  const [submitted, setSubmitted] = useState(false);

  const q = questions[idx];
  const bundle = questions.length > 1;
  const inert = answered || submitted;
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
  // T5 리뷰 미너 #1 — Send에 선택이 하나도 없으면(옵션 미선택+기타 빈칸) Skip과 똑같이 조용히
  // 건너뛰어지는 것을 막는다: 그 경우 Send는 아무 일도 하지 않는다(Skip 버튼은 그대로 동작).
  const noSelection = currentAnswer() === null;

  const finalize = (skip: boolean) => {
    if (submitted) return; // 미너 #2 — 이미 최종 전송됨(echo 대기 중), 재클릭 무시.
    if (!skip && noSelection) return; // 미너 #1 — 아무것도 안 골랐는데 Send는 no-op.
    const raw = skip ? null : currentAnswer();
    const next = [...segments];
    next[idx] = raw;
    if (idx === questions.length - 1) {
      let finalText: string;
      if (bundle) {
        const parts = next.map((a, i) => (a === null ? null : `${segmentLabel(questions[i])}: ${a}`));
        const nonNull = parts.filter((p): p is string => p !== null);
        finalText = nonNull.length ? nonNull.join(' / ') : T.qSkipped;
      } else {
        // D1 — 단일 질문은 접두어 없이 답 그 자체(전부 skip이면 리터럴 (skipped)).
        finalText = next[0] === null ? T.qSkipped : next[0];
      }
      setSegments(next);
      setSubmitted(true);
      onAnswer(finalText, msgId);
    } else {
      setSegments(next);
      setIdx(idx + 1);
      setSelectedSet(new Set());
      setOtherActive(false);
      setOtherText('');
    }
  };

  const selectOption = (i: number) => {
    if (inert) return;
    if (q.multiSelect) {
      setSelectedSet((p) => { const n = new Set(p); if (n.has(i)) n.delete(i); else n.add(i); return n; });
    } else {
      setSelectedSet(new Set([i]));
      setOtherActive(false);
    }
  };
  const selectOther = () => {
    if (inert) return;
    if (q.multiSelect) setOtherActive((p) => !p);
    else { setSelectedSet(new Set()); setOtherActive(true); }
  };
  const onOtherChange = (v: string) => {
    if (inert) return;
    setOtherText(v);
    if (v.trim()) {
      setOtherActive(true);
      if (!q.multiSelect) setSelectedSet(new Set());
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (inert) return;
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
    <div className={'qcard' + (answered ? ' answered' : '')} tabIndex={inert ? -1 : 0} onKeyDown={onKeyDown} aria-label={q.q}>
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
                {answered && chosen && <span className="qcheck">✓ </span>}{o.label}
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
        <input type="text" placeholder={T.qOtherPh} value={otherRowValue} disabled={inert}
               onClick={(e) => e.stopPropagation()} onChange={(e) => onOtherChange(e.target.value)} />
      </div>
      {!answered && (
        <div className="qfoot">
          <button type="button" className="qskip" disabled={submitted} onClick={() => finalize(true)}>{T.qSkip}</button>
          <button type="button" disabled={submitted || noSelection} onClick={() => finalize(false)}>{T.send}</button>
        </div>
      )}
    </div>
  );
}
