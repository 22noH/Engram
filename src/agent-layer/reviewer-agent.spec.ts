import { ReviewerAgent } from './reviewer-agent';

describe('ReviewerAgent', () => {
  const make = (text: string) => new ReviewerAgent({ complete: () => Promise.resolve({ text, costUsd: 0, isError: false }) } as any);

  it('승인 JSON 파싱', async () => {
    const r = await make('{"approved":true,"extraTickets":[]}').review(['c1'], '착지요약');
    expect(r).toEqual({ approved: true, extraTickets: [] });
  });
  it('추가 티켓 파싱', async () => {
    const r = await make('앞말 {"approved":false,"extraTickets":[{"area":"src/x","instruction":"엣지케이스"}]} 뒷말').review(['c1'], 's');
    expect(r.approved).toBe(false);
    expect(r.extraTickets[0]).toMatchObject({ area: 'src/x' });
  });
  it('파싱 실패는 approved=false + 빈 티켓', async () => {
    const r = await make('JSON 없음').review(['c1'], 's');
    expect(r).toEqual({ approved: false, extraTickets: [] });
  });
  it('두뇌 에러도 approved=false', async () => {
    const r = await new ReviewerAgent({ complete: () => Promise.resolve({ text: '', costUsd: 0, isError: true }) } as any).review(['c1'], 's');
    expect(r.approved).toBe(false);
  });
});
