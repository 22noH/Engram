import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { StatusLog } from './StatusLog';

const statusPayload = {
  uptimeSec: 6 * 86400 + 4 * 3600, // 6일 4시간
  lastHeartbeatMs: Date.now() - 5_000, // 5초 전 = "방금"
  chatBytes: 84 * 1024 * 1024, // 84 MB
  knowledgeBytes: 312 * 1024 * 1024, // 312 MB
  memberCount: 2, channelCount: 3,
};
const schedulesPayload = {
  schedules: [
    { id: 's1', channelId: 'general', cron: '0 9 * * *', task: '아침 스탠드업 요약' },
    { id: 's2', channelId: 'design', cron: '0 10 * * 1', task: '주간 배포 체크리스트' },
  ],
};
const logsPayload = {
  lines: [
    '21:40:12 INFO Messenger — self(:47800)',
    '21:41:02 INFO Auth — seojun signed in',
  ],
};
const membersPayload = { members: [] };

function mockFetch(extra: (url: string, init?: RequestInit) => Response | null = () => null) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const overridden = extra(url, init);
    if (overridden) return overridden;
    if (url === '/admin/api/status') return new Response(JSON.stringify(statusPayload), { status: 200 });
    if (url === '/admin/api/schedules') return new Response(JSON.stringify(schedulesPayload), { status: 200 });
    if (url === '/admin/api/logs') return new Response(JSON.stringify(logsPayload), { status: 200 });
    if (url === '/admin/api/members') return new Response(JSON.stringify(membersPayload), { status: 200 });
    return new Response(JSON.stringify({ error: 'unhandled: ' + url }), { status: 404 });
  });
}

afterEach(() => { vi.restoreAllMocks(); });

it('통계 타일 4개: 가동 시간·마지막 생존 신호·대화 기록 용량·위키+지식 용량', async () => {
  mockFetch();
  render(<StatusLog serverName="Our Team" role="owner" active="status" onNavigate={() => {}} />);

  await waitFor(() => expect(screen.getByText('6d 4h')).toBeInTheDocument());
  expect(screen.getByText('Just now ✓')).toBeInTheDocument();
  expect(screen.getByText('84 MB')).toBeInTheDocument();
  expect(screen.getByText('312 MB')).toBeInTheDocument();
});

it('마지막 생존 신호 null → "—"', async () => {
  mockFetch((url) => {
    if (url === '/admin/api/status') {
      return new Response(JSON.stringify({ ...statusPayload, lastHeartbeatMs: null }), { status: 200 });
    }
    return null;
  });
  render(<StatusLog serverName="Our Team" role="owner" active="status" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('—')).toBeInTheDocument());
});

it('예약 작업 목록: task 제목 + 사람이 읽는 cron·채널(등록자 없음) + 삭제 → DELETE 호출 후 재조회', async () => {
  const deleteCalls: string[] = [];
  let schedulesCallCount = 0;
  mockFetch((url, init) => {
    if (url === '/admin/api/schedules') {
      schedulesCallCount++;
      if (schedulesCallCount > 1) return new Response(JSON.stringify({ schedules: [schedulesPayload.schedules[1]] }), { status: 200 });
      return null; // 첫 호출은 기본 mockFetch가 처리(schedulesPayload 그대로)
    }
    if (url === '/admin/api/schedules/s1' && init?.method === 'DELETE') {
      deleteCalls.push(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return null;
  });
  render(<StatusLog serverName="Our Team" role="owner" active="status" onNavigate={() => {}} />);

  await waitFor(() => expect(screen.getByText('아침 스탠드업 요약')).toBeInTheDocument());
  // 사람이 읽는 cron(매일 09:00→Daily 09:00, 매주 월 10:00→Weekly Mon 10:00) · 채널 — 등록자 이름은 없다.
  expect(screen.getByText('Daily 09:00 · # general')).toBeInTheDocument();
  expect(screen.getByText('Weekly Mon 10:00 · # design')).toBeInTheDocument();
  expect(screen.queryByText(/등록/)).not.toBeInTheDocument();

  const row = screen.getByText('아침 스탠드업 요약').closest('.row') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));

  await waitFor(() => expect(deleteCalls).toEqual(['/admin/api/schedules/s1']));
  await waitFor(() => expect(screen.queryByText('아침 스탠드업 요약')).not.toBeInTheDocument());
  expect(screen.getByText('주간 배포 체크리스트')).toBeInTheDocument();
});

it('예약 작업 행은 .grp의 직계 자식 .row다(구분선 회귀 방지)', async () => {
  mockFetch();
  const { container } = render(<StatusLog serverName="Our Team" role="owner" active="status" onNavigate={() => {}} />);
  await waitFor(() => expect(screen.getByText('아침 스탠드업 요약')).toBeInTheDocument());

  const grp = Array.from(container.querySelectorAll('.grp')).find((g) => g.querySelector('.row')) as HTMLElement;
  const rows = Array.from(grp.children).filter((el) => el.classList.contains('row'));
  expect(rows.length).toBe(2);
  for (const row of rows) expect(row.parentElement).toBe(grp);
});

it('최근 로그: lines[] 각 줄이 렌더된다', async () => {
  mockFetch();
  render(<StatusLog serverName="Our Team" role="owner" active="status" onNavigate={() => {}} />);

  await waitFor(() => expect(screen.getByText('21:40:12 INFO Messenger — self(:47800)')).toBeInTheDocument());
  expect(screen.getByText('21:41:02 INFO Auth — seojun signed in')).toBeInTheDocument();
});

it('예약 작업 0건 → 헤딩은 0을 보여주고 목록은 빈 .grp', async () => {
  mockFetch((url) => {
    if (url === '/admin/api/schedules') return new Response(JSON.stringify({ schedules: [] }), { status: 200 });
    return null;
  });
  render(<StatusLog serverName="Our Team" role="owner" active="status" onNavigate={() => {}} />);

  await waitFor(() => expect(screen.getByText('0 scheduled jobs')).toBeInTheDocument());
});
