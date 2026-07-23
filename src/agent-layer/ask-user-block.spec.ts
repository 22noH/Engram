import { extractAskUser, questionFallbackText, validateAskUserPayload } from './ask-user-block';

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

  // T3 리뷰 minor 1: CRLF(\r\n) 줄바꿈으로 온 블록도 추출되고 주변 본문은 무사해야.
  it('CRLF(\\r\\n) 줄바꿈 블록도 추출되고 주변 본문은 그대로', () => {
    const json = JSON.stringify({ questions: [{ q: 'q?', options: [{ label: 'a' }, { label: 'b' }] }] });
    const text = ['앞 문장입니다.', '', '```ask_user', json, '```', '뒷 문장입니다.'].join('\r\n');
    const r = extractAskUser(text);
    expect(r.question?.questions[0].q).toBe('q?');
    expect(r.text).toContain('앞 문장입니다.');
    expect(r.text).toContain('뒷 문장입니다.');
    expect(r.text).not.toContain('ask_user');
  });

  // T3 리뷰 minor 2: 상한 경계(질문 4개·옵션 4개)는 거부가 아니라 통과해야.
  it('질문 정확히 4개 → 유효(상한 경계 통과)', () => {
    const q = { q: 'q?', options: [{ label: 'a' }, { label: 'b' }] };
    const text = ['```ask_user', JSON.stringify({ questions: [q, q, q, q] }), '```'].join('\n');
    const r = extractAskUser(text);
    expect(r.question?.questions).toHaveLength(4);
  });

  it('옵션 정확히 4개 → 유효(상한 경계 통과)', () => {
    const text = [
      '```ask_user',
      JSON.stringify({ questions: [{ q: 'q?', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }] }] }),
      '```',
    ].join('\n');
    const r = extractAskUser(text);
    expect(r.question?.questions[0].options).toHaveLength(4);
  });
});

// T3 리뷰 Important: validateAskUserPayload를 공개 API로 직접 검증(Task 4가 펜스 텍스트 없이
// 원시 도구호출 input:unknown을 이 함수 하나로 검증할 수 있어야 한다 — extractAskUser 내부도 같은 함수 재사용).
describe('validateAskUserPayload', () => {
  it('유효 원시 객체 → 정제된 payload(여분 키는 버림)', () => {
    const raw = {
      questions: [
        { q: '진행할까요?', extra: 'junk', options: [{ label: '예', bogus: 1 }, { label: '아니오' }] },
      ],
      topLevelJunk: true,
    };
    expect(validateAskUserPayload(raw)).toEqual({
      questions: [{ q: '진행할까요?', options: [{ label: '예' }, { label: '아니오' }] }],
    });
  });

  it('질문 5개(상한 초과) → null', () => {
    const q = { q: 'q?', options: [{ label: 'a' }, { label: 'b' }] };
    expect(validateAskUserPayload({ questions: [q, q, q, q, q] })).toBeNull();
  });

  it('옵션 1개(하한 미달) → null', () => {
    expect(validateAskUserPayload({ questions: [{ q: 'q?', options: [{ label: '단일' }] }] })).toBeNull();
  });

  it('label이 string이 아니면 → null', () => {
    expect(
      validateAskUserPayload({ questions: [{ q: 'q?', options: [{ label: 123 }, { label: 'b' }] }] }),
    ).toBeNull();
  });

  it('최상위가 객체가 아니면 → null', () => {
    expect(validateAskUserPayload('그냥 문자열')).toBeNull();
    expect(validateAskUserPayload(null)).toBeNull();
  });

  // 최종 리뷰 픽스: 한 질문에 recommended:true가 여러 개면 거부하지 않고 첫 번째만 남긴다.
  it('한 질문에 recommended:true 3개 → 첫 번째만 살아남고 나머지는 플래그 제거', () => {
    const r = validateAskUserPayload({
      questions: [
        {
          q: 'q?',
          options: [
            { label: 'a', recommended: true },
            { label: 'b', recommended: true },
            { label: 'c', recommended: true },
          ],
        },
      ],
    });
    expect(r).toEqual({
      questions: [
        {
          q: 'q?',
          options: [{ label: 'a', recommended: true }, { label: 'b' }, { label: 'c' }],
        },
      ],
    });
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
