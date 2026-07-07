import { CODE_CHAT_DEFAULT, buildCodeChatPrompt, extractPropose } from './code-chat';

describe('extractPropose', () => {
  it('마커 없으면 답만, goal 없음', () => {
    expect(extractPropose('그냥 설명이야.')).toEqual({ reply: '그냥 설명이야.' });
  });
  it('마커 있으면 떼어내고 goal 뽑음', () => {
    const t = '여기 원인이야.\n```engram:propose\n{"goal":"로그인 버그 고치기"}\n```';
    expect(extractPropose(t)).toEqual({ reply: '여기 원인이야.', goal: '로그인 버그 고치기' });
  });
  it('마커 JSON 깨졌으면 제안 없이 답만(마커는 제거)', () => {
    const t = '답.\n```engram:propose\n{망가짐\n```';
    const r = extractPropose(t);
    expect(r.goal).toBeUndefined();
    expect(r.reply).toBe('답.');
  });
  it('goal 빈 문자열이면 제안 없음', () => {
    const t = '답.\n```engram:propose\n{"goal":"  "}\n```';
    expect(extractPropose(t).goal).toBeUndefined();
  });
});

describe('buildCodeChatPrompt', () => {
  it('{path} 치환 + 사용자 메시지 + 제안 계약 포함', () => {
    const p = buildCodeChatPrompt(CODE_CHAT_DEFAULT, { repoPath: 'C:/r', userText: '왜 막혔어?' });
    expect(p).toContain('C:/r');
    expect(p).toContain('왜 막혔어?');
    expect(p).toContain('```engram:propose');
  });
  it('recent·taskStatus 있으면 섹션으로 붙고, 없으면 생략', () => {
    const withCtx = buildCodeChatPrompt('X {path}', { repoPath: 'C:/r', userText: 'q', recent: 'Q: a\nA: b', taskStatus: '- 코딩: r — failed' });
    expect(withCtx).toContain('최근 대화');
    expect(withCtx).toContain('작업 상태');
    const without = buildCodeChatPrompt('X {path}', { repoPath: 'C:/r', userText: 'q' });
    expect(without).not.toContain('최근 대화');
    expect(without).not.toContain('작업 상태');
  });
});
