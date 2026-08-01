import { render, screen, act, waitFor, fireEvent, cleanup } from '@testing-library/react';
import App from './App';
import { T } from './i18n';

// 진행 카드 + 완료 보고서를 실제 대화 화면에서(App까지 붙여) 확인한다.
// 특히 ★재시작 복원: 같은 기록(history 프레임)을 다시 받았을 때 카드가 그대로 복원돼야 한다 —
// 휘발 상태로 묶었다면 여기서 옛 진행 메시지가 우르르 풀려 보인다.

class FakeWS {
  static last: FakeWS;
  static OPEN = 1;
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null; onerror: (() => void) | null = null;
  readyState = 1; sent: string[] = [];
  constructor() { FakeWS.last = this; }
  send(d: string) { this.sent.push(d); }
  close() {}
}

beforeEach(() => { localStorage.clear(); (globalThis as any).WebSocket = FakeWS as any; });
afterEach(() => { vi.restoreAllMocks(); delete (window as any).engramDesktop; });

const CHAT = { id: 'g1', name: 'general', respondMode: 'all', mode: 'chat' };
const run = { id: 'r1', title: '자율 코딩' };
const ts = (secAgo: number): string => new Date(Date.now() - secAgo * 1000).toISOString();

const HISTORY = [
  { id: 'u1', authorId: 'me', text: '리뷰 붙여줘', ts: ts(400) },
  { id: 'p1', authorId: 'engram', text: '· 자율 코딩 시작', ts: ts(320), progress: true, progressRun: run },
  { id: 'p2', authorId: 'engram', text: '· 분해 완료 — 작업 2개', ts: ts(300), progress: true, progressRun: run },
  { id: 'p3', authorId: 'engram', text: '· ✗ 실패: backend [사용량 한도]', ts: ts(200), progress: true, progressRun: { ...run, kind: 'retry' } },
  { id: 'p4', authorId: 'engram', text: '· ✓ 착지: backend', ts: ts(100), progress: true, progressRun: run },
  { id: 'r9', authorId: 'engram', text: '# 자동 리뷰 붙이기\n\n**남은 것 · 판단 필요**\n\n- 폴링이라 실시간이 아닙니다', ts: ts(90), completionReport: true },
];

async function openWith(messages: unknown[]) {
  render(<App />);
  act(() => { FakeWS.last.onopen!(); });
  act(() => {
    FakeWS.last.onmessage!({ data: JSON.stringify({ t: 'channels', list: [CHAT], brainNames: ['claude'], defaultBrain: 'claude' }) });
  });
  await waitFor(() => expect(screen.getByText('# general')).toBeInTheDocument());
  act(() => {
    FakeWS.last.onmessage!({ data: JSON.stringify({ t: 'history', channelId: 'g1', messages }) });
  });
  await waitFor(() => expect(document.querySelector('#msgs')).toBeInTheDocument());
}

const cards = (): NodeListOf<Element> => document.querySelectorAll('.progressCard');

it('진행 보고 4개가 카드 한 장으로 접힌다 — 대화를 밀어내지 않는다', async () => {
  await openWith(HISTORY);
  expect(cards()).toHaveLength(1);
  expect(document.querySelectorAll('.msg.progress')).toHaveLength(0); // 낱개 진행 줄은 없다
  expect(document.querySelector('.pcSteps')).toBeNull();              // 접힌 채로
  fireEvent.click(document.querySelector('.pcHead')!);
  expect(document.querySelectorAll('.pcStep')).toHaveLength(4);
});

it('★재시작 후에도 같은 카드가 복원된다(기록만으로 묶기 때문)', async () => {
  await openWith(HISTORY);
  expect(cards()).toHaveLength(1);
  cleanup(); // 앱 종료

  await openWith(HISTORY); // 다시 켜서 같은 기록을 받는다
  expect(cards()).toHaveLength(1);
  expect(document.querySelectorAll('.msg.progress')).toHaveLength(0);
  // 실행이 끝난 뒤라 완료 머리글 + 접힘
  expect(document.querySelector('.pcHead')!.textContent).toContain(T.progressCardDone('자율 코딩'));
  expect(document.querySelector('.progressCard')!.className).toContain('done');
});

it('마지막 메시지가 진행 보고면 그 카드가 아직 도는 중이다', async () => {
  await openWith(HISTORY.slice(0, 5)); // 보고서 없이 진행 보고에서 끊긴 상태
  expect(document.querySelector('.progressCard')!.className).toContain('running');
  expect(document.querySelector('.pcHead')!.textContent).toContain('착지: backend');
});

it('다른 실행이 섞이지 않는다 — 카드가 두 장으로 갈린다', async () => {
  await openWith([
    ...HISTORY,
    { id: 'q1', authorId: 'engram', text: '· 팀 구성', ts: ts(50), progress: true, progressRun: { id: 'r2', title: '협업' } },
    { id: 'q2', authorId: 'engram', text: '· 의견 도착', ts: ts(40), progress: true, progressRun: { id: 'r2', title: '협업' } },
  ]);
  expect(cards()).toHaveLength(2);
});

it('완료 보고서는 카드 아래에 그대로 보인다(액션 줄은 코드 채널·데스크톱에서만)', async () => {
  await openWith(HISTORY);
  expect(document.querySelector('.msg.report')).not.toBeNull();
  expect(document.body.textContent).toContain('남은 것');
  expect(document.querySelector('.reportActions')).toBeNull(); // 채팅 채널엔 변경점/PR이 없다
});

it('스레드 답글로 달린 진행 보고도 카드로 접힌다(실사고 2026-08-01 — 턴 응답은 유발 메시지 밑에 threadId가 달린다)', async () => {
  await openWith([
    { id: 'u1', authorId: 'me', text: '리뷰 붙여줘', ts: ts(400) },
    ...HISTORY.slice(1, 5).map((m) => ({ ...m, threadId: 'u1' })),
  ]);
  expect(cards()).toHaveLength(1);
  expect(document.querySelectorAll('.msg.progress')).toHaveLength(0); // 낱개 진행 줄 없음
  fireEvent.click(document.querySelector('.pcHead')!);
  expect(document.querySelectorAll('.pcStep')).toHaveLength(4);
});

it('진행 표시가 없는 보통 대화는 카드를 만들지 않는다(회귀 0)', async () => {
  await openWith([
    { id: 'a', authorId: 'me', text: '안녕', ts: ts(10) },
    { id: 'b', authorId: 'engram', text: '네', ts: ts(5) },
  ]);
  expect(cards()).toHaveLength(0);
});
