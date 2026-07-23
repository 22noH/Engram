import { render, screen, fireEvent } from '@testing-library/react';
import { QuestionCard } from './QuestionCard';
import { T } from '../i18n';
import type { QuestionItem } from '../../../shared/protocol';

const single: QuestionItem[] = [
  { q: '어느 접근을 쓸까요?', header: '접근', options: [
    { label: 'A안', desc: '빠름', recommended: true },
    { label: 'B안', desc: '안전함' },
  ] },
];

it('렌더: 번호칩 순서·추천 배지·옵션이 다 보인다(단일 질문이면 1/N은 안 보임)', () => {
  const { container } = render(<QuestionCard msgId="m1" question={{ questions: single }} onAnswer={() => {}} />);
  const nums = Array.from(container.querySelectorAll('.qnum')).map((n) => n.textContent);
  expect(nums).toEqual(['1', '2', '3']); // 옵션 2개 + 기타 1개
  expect(screen.getByText(T.qRecommended)).toBeInTheDocument();
  expect(screen.queryByText(/^\d\/\d$/)).not.toBeInTheDocument(); // 묶음 아니므로 1/N 없음
});

it('묶음이면 1/N 카운터가 보인다', () => {
  const q2: QuestionItem[] = [...single, { q: '두번째 질문', options: [{ label: 'X' }, { label: 'Y' }] }];
  render(<QuestionCard msgId="m1" question={{ questions: q2 }} onAnswer={() => {}} />);
  expect(screen.getByText('1/2')).toBeInTheDocument();
});

it('옵션 클릭만으로는 전송되지 않는다', () => {
  const onAnswer = vi.fn();
  render(<QuestionCard msgId="m1" question={{ questions: single }} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByText('A안'));
  expect(onAnswer).not.toHaveBeenCalled();
});

// T5 리뷰 D1 — 단일 질문은 접두어 없이 답 그 자체(승인된 목업의 답 버블이 순수 답만 보여준다).
it('Send를 눌러야 onAnswer(text, msgId)가 1회 호출된다(단일 질문=플레인, 접두어 없음)', () => {
  const onAnswer = vi.fn();
  render(<QuestionCard msgId="m1" question={{ questions: single }} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByText('A안'));
  fireEvent.click(screen.getByText(T.send));
  expect(onAnswer).toHaveBeenCalledTimes(1);
  expect(onAnswer).toHaveBeenCalledWith('A안', 'm1');
});

it('기타 입력에 타이핑하면 기타가 선택되고, Send로 그 텍스트가 그대로(접두어 없이) 전송된다', () => {
  const onAnswer = vi.fn();
  render(<QuestionCard msgId="m1" question={{ questions: single }} onAnswer={onAnswer} />);
  fireEvent.change(screen.getByPlaceholderText(T.qOtherPh), { target: { value: 'C안으로 해줘' } });
  fireEvent.click(screen.getByText(T.send));
  expect(onAnswer).toHaveBeenCalledWith('C안으로 해줘', 'm1');
});

it('multiSelect(단일 질문): 여러 옵션을 골라 Send하면 콤마로 합쳐 접두어 없이 전송된다', () => {
  const multi: QuestionItem[] = [{ q: '뭘 넣을까요?', header: '토핑', multiSelect: true, options: [
    { label: '치즈' }, { label: '올리브' }, { label: '버섯' },
  ] }];
  const onAnswer = vi.fn();
  render(<QuestionCard msgId="m1" question={{ questions: multi }} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByText('치즈'));
  fireEvent.click(screen.getByText('버섯'));
  fireEvent.click(screen.getByText(T.send));
  expect(onAnswer).toHaveBeenCalledWith('치즈, 버섯', 'm1');
});

it('묶음 2문항: 각 질문을 Send로 넘기면 마지막에 header: 답 을 / 로 합쳐 한 번만 전송된다', () => {
  const q2: QuestionItem[] = [
    { q: '첫번째', header: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
    { q: '두번째', header: 'Q2', options: [{ label: 'X' }, { label: 'Y' }] },
  ];
  const onAnswer = vi.fn();
  render(<QuestionCard msgId="m1" question={{ questions: q2 }} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByText('A'));
  fireEvent.click(screen.getByText(T.send)); // 다음 질문으로 진행, 아직 전송 안 됨
  expect(onAnswer).not.toHaveBeenCalled();
  expect(screen.getByText('두번째')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Y'));
  fireEvent.click(screen.getByText(T.send));
  expect(onAnswer).toHaveBeenCalledTimes(1);
  expect(onAnswer).toHaveBeenCalledWith('Q1: A / Q2: Y', 'm1');
});

it('answeredText가 있으면 컨트롤이 무동작(클릭해도 onAnswer 미호출, Send/Skip 버튼 없음)', () => {
  const onAnswer = vi.fn();
  render(<QuestionCard msgId="m1" question={{ questions: single }} answeredText="A안" onAnswer={onAnswer} />);
  fireEvent.click(screen.getByText('B안'));
  expect(onAnswer).not.toHaveBeenCalled();
  expect(screen.queryByText(T.send)).not.toBeInTheDocument();
  expect(screen.queryByText(T.qSkip)).not.toBeInTheDocument();
  const container = screen.getByLabelText(single[0].q);
  expect(container.className).toContain('answered');
});

it('전부 Skip이면 리터럴 (skipped)가 전송된다(단일 질문)', () => {
  const onAnswer = vi.fn();
  render(<QuestionCard msgId="m1" question={{ questions: single }} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByText(T.qSkip));
  expect(onAnswer).toHaveBeenCalledWith(T.qSkipped, 'm1');
});

it('묶음에서 전부 Skip하면 (skipped)가 전송된다', () => {
  const q2: QuestionItem[] = [
    { q: '첫번째', options: [{ label: 'A' }, { label: 'B' }] },
    { q: '두번째', options: [{ label: 'X' }, { label: 'Y' }] },
  ];
  const onAnswer = vi.fn();
  render(<QuestionCard msgId="m1" question={{ questions: q2 }} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByText(T.qSkip));
  fireEvent.click(screen.getByText(T.qSkip));
  expect(onAnswer).toHaveBeenCalledWith(T.qSkipped, 'm1');
});

it('키보드: 카드에 포커스된 뒤 숫자키로 선택하고 Enter로 전송한다', () => {
  const onAnswer = vi.fn();
  render(<QuestionCard msgId="m1" question={{ questions: single }} onAnswer={onAnswer} />);
  const card = screen.getByLabelText(single[0].q);
  card.focus();
  fireEvent.keyDown(card, { key: '2' }); // 두번째 옵션(B안) 선택
  fireEvent.keyDown(card, { key: 'Enter' });
  expect(onAnswer).toHaveBeenCalledWith('B안', 'm1');
});

// T5 리뷰 미너 #1 — 아무것도 선택하지 않은 채 Send를 눌러도 조용히 Skip처럼 처리되면 안 된다.
it('선택 없이 Send를 누르면 onAnswer가 호출되지 않는다(Send 버튼도 disabled)', () => {
  const onAnswer = vi.fn();
  render(<QuestionCard msgId="m1" question={{ questions: single }} onAnswer={onAnswer} />);
  const sendBtn = screen.getByText(T.send) as HTMLButtonElement;
  expect(sendBtn.disabled).toBe(true);
  fireEvent.click(sendBtn);
  expect(onAnswer).not.toHaveBeenCalled();
});

// T5 리뷰 미너 #2 — 서버 echo(answeredText) 오기 전 이중클릭으로 onAnswer가 두 번 나가면 안 된다.
it('Send를 빠르게 두 번 눌러도 onAnswer는 한 번만 호출된다', () => {
  const onAnswer = vi.fn();
  render(<QuestionCard msgId="m1" question={{ questions: single }} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByText('A안'));
  const sendBtn = screen.getByText(T.send);
  fireEvent.click(sendBtn);
  fireEvent.click(sendBtn);
  expect(onAnswer).toHaveBeenCalledTimes(1);
});
