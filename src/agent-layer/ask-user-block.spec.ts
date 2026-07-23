import { extractAskUser, questionFallbackText } from './ask-user-block';

describe('extractAskUser', () => {
  it('유효 블록 — 본문 분리 + question 파싱', () => {
    const text = [
      '검토해봤는데 두 방향이 있어요.',
      '',
      '```ask_user',
      JSON.stringify({
        questions: [
          {
            q: '어느 쪽으로 진행할까요?',
            header: '방향 선택',
            options: [
              { label: 'A안', desc: '빠르지만 임시', recommended: true },
              { label: 'B안', desc: '느리지만 근본' },
            ],
          },
        ],
      }),
      '```',
    ].join('\n');

    const r = extractAskUser(text);
    expect(r.text).toBe('검토해봤는데 두 방향이 있어요.');
    expect(r.question).toEqual({
      questions: [
        {
          q: '어느 쪽으로 진행할까요?',
          header: '방향 선택',
          options: [
            { label: 'A안', desc: '빠르지만 임시', recommended: true },
            { label: 'B안', desc: '느리지만 근본' },
          ],
        },
      ],
    });
  });

  it('알 수 없는 여분 키는 버리고 검증된 필드만 남긴다', () => {
    const text = [
      '```ask_user',
      JSON.stringify({
        questions: [
          { q: '진행할까요?', extra: 'junk', options: [{ label: '예', bogus: 1 }, { label: '아니오' }] },
        ],
        topLevelJunk: true,
      }),
      '```',
    ].join('\n');
    const r = extractAskUser(text);
    expect(r.question).toEqual({
      questions: [{ q: '진행할까요?', options: [{ label: '예' }, { label: '아니오' }] }],
    });
  });

  it('무효 JSON → 원문 그대로', () => {
    const text = '```ask_user\n{이건 JSON 아님\n```';
    const r = extractAskUser(text);
    expect(r).toEqual({ text });
    expect(r.question).toBeUndefined();
  });

  it('옵션 1개(최소 2 미달) → 원문 그대로', () => {
    const text = [
      '```ask_user',
      JSON.stringify({ questions: [{ q: 'q?', options: [{ label: '단일' }] }] }),
      '```',
    ].join('\n');
    const r = extractAskUser(text);
    expect(r).toEqual({ text });
  });

  it('질문 5개(최대 4 초과) → 원문 그대로', () => {
    const q = { q: 'q?', options: [{ label: 'a' }, { label: 'b' }] };
    const text = [
      '```ask_user',
      JSON.stringify({ questions: [q, q, q, q, q] }),
      '```',
    ].join('\n');
    const r = extractAskUser(text);
    expect(r).toEqual({ text });
  });

  it('label 빈 문자열 → 원문 그대로', () => {
    const text = [
      '```ask_user',
      JSON.stringify({ questions: [{ q: 'q?', options: [{ label: '' }, { label: 'b' }] }] }),
      '```',
    ].join('\n');
    const r = extractAskUser(text);
    expect(r).toEqual({ text });
  });

  it('블록만 있고 본문 없음 → text=""', () => {
    const text = [
      '```ask_user',
      JSON.stringify({ questions: [{ q: 'q?', options: [{ label: 'a' }, { label: 'b' }] }] }),
      '```',
    ].join('\n');
    const r = extractAskUser(text);
    expect(r.text).toBe('');
    expect(r.question).toBeDefined();
  });

  it('블록이 없으면 원문 그대로, question 없음', () => {
    const r = extractAskUser('그냥 평범한 답변입니다.');
    expect(r).toEqual({ text: '그냥 평범한 답변입니다.' });
  });

  it('두 개 이상이면 첫 블록만 추출, 나머지는 텍스트로 남는다', () => {
    const block = (q: string): string =>
      ['```ask_user', JSON.stringify({ questions: [{ q, options: [{ label: 'a' }, { label: 'b' }] }] }), '```'].join('\n');
    const text = `${block('첫번째?')}\n남는 글\n${block('두번째?')}`;
    const r = extractAskUser(text);
    expect(r.question?.questions[0].q).toBe('첫번째?');
    expect(r.text).toContain('남는 글');
    expect(r.text).toContain('```ask_user');
    expect(r.text).toContain('두번째?');
  });
});

describe('questionFallbackText', () => {
  it('질문 + 번호 매긴 라벨 — 설명 줄들을 만든다', () => {
    const text = questionFallbackText({
      questions: [
        {
          q: '어느 쪽으로 진행할까요?',
          options: [
            { label: 'A안', desc: '빠르지만 임시' },
            { label: 'B안', desc: '느리지만 근본' },
          ],
        },
      ],
    });
    expect(text).toBe('어느 쪽으로 진행할까요?\n1. A안 — 빠르지만 임시\n2. B안 — 느리지만 근본');
  });

  it('desc가 없으면 — 없이 라벨만', () => {
    const text = questionFallbackText({ questions: [{ q: 'q?', options: [{ label: 'a' }, { label: 'b' }] }] });
    expect(text).toBe('q?\n1. a\n2. b');
  });

  it('질문 여러 개는 빈 줄로 구분', () => {
    const text = questionFallbackText({
      questions: [
        { q: 'q1?', options: [{ label: 'a' }, { label: 'b' }] },
        { q: 'q2?', options: [{ label: 'c' }, { label: 'd' }] },
      ],
    });
    expect(text).toBe('q1?\n1. a\n2. b\n\nq2?\n1. c\n2. d');
  });
});
