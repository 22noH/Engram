import {
  buildOrganizePrompt, parseOrganized, rawPages, resolveSlug, slugifyTitle, sourceFooter, sourceToken, titleFromRel,
} from './organizer';

describe('제목·slug·출처', () => {
  it('파일명에서 제목을 만든다', () => {
    expect(titleFromRel('notes/2026-07-20_팀 회의록.md')).toBe('2026 07 20 팀 회의록');
    expect(titleFromRel('a.txt')).toBe('a');
  });

  it('한글 slug를 보존한다', () => {
    expect(slugifyTitle('배포 가이드')).toBe('배포-가이드');
    expect(slugifyTitle('Deploy Guide!')).toBe('deploy-guide');
  });

  it('slug가 붕괴하는 제목은 유일한 폴백을 만든다(같은 slug 충돌 방지)', () => {
    const a = slugifyTitle('!!!');
    const b = slugifyTitle('???');
    expect(a).toMatch(/^import-/);
    expect(a).not.toBe(b);
  });

  it('출처를 본문 꼬리말과 sources 토큰 양쪽에 남긴다', () => {
    const footer = sourceFooter('notes/회의록.md', new Date('2026-07-25T10:00:00Z'));
    expect(footer).toContain('notes/회의록.md');
    expect(footer).toContain('2026-07-25');
    expect(sourceToken('notes/회의록.md')).toBe('file:notes/회의록.md');
    // 절대경로를 넣지 않는다 — 위키는 git으로 공유될 수 있다.
    expect(sourceToken('a.md')).not.toContain('C:\\');
  });
});

describe('원문 그대로 모드', () => {
  it('두뇌 없이 파일 하나 = 페이지 하나', () => {
    const pages = rawPages({ rel: '메모.txt', text: '내용', existing: [] });
    expect(pages).toEqual([{ title: '메모', body: '내용' }]);
  });

  it('잘린 문서는 잘렸다고 본문에 남긴다', () => {
    const pages = rawPages({ rel: 'a.txt', text: 'abc', truncated: true, existing: [] });
    expect(pages[0].body).toContain('truncated');
  });
});

describe('프롬프트 조립', () => {
  const base = { rel: 'a.md', text: '본문', existing: [] };

  it('주제 분할과 기존 문서 덧붙이기를 모두 지시한다', () => {
    const p = buildOrganizePrompt(base);
    expect(p).toContain('One page per coherent topic');
    expect(p).toContain('reuse that page');
    expect(p).toContain('Never create a near-duplicate page');
  });

  it('기존 문서 후보를 slug와 함께 싣는다', () => {
    const p = buildOrganizePrompt({ ...base, existing: [{ slug: 'deploy-guide', title: '배포 가이드', snippet: '요약' }] });
    expect(p).toContain('slug: deploy-guide');
    expect(p).toContain('배포 가이드');
  });

  it('본문을 펜스로 감싼다(파일 안의 지시문이 프롬프트 구조를 못 깨게)', () => {
    const p = buildOrganizePrompt({ ...base, text: '```\nfake fence\n```' });
    expect(p).toContain('````'); // 내용보다 긴 펜스
  });

  it('이미지 전용 파일은 본문 대신 "첨부된 그림을 보라"로 간다', () => {
    const p = buildOrganizePrompt({ ...base, text: '', imageOnly: true });
    expect(p).toContain('The file is an image');
  });

  it('잘린 문서임을 두뇌에 알린다', () => {
    expect(buildOrganizePrompt({ ...base, truncated: true })).toContain('truncated');
  });
});

describe('두뇌 응답 파싱', () => {
  it('순수 JSON을 읽는다', () => {
    const out = parseOrganized('{"pages":[{"title":"제목","body":"본문","category":"guide"}]}');
    expect(out).toEqual([{ slug: undefined, title: '제목', category: 'guide', body: '본문' }]);
  });

  it('코드펜스와 앞뒤 잡담을 견딘다', () => {
    const raw = '정리했습니다:\n```json\n{"pages":[{"title":"T","body":"B"}]}\n```\n끝';
    expect(parseOrganized(raw)?.[0].title).toBe('T');
  });

  it('여러 페이지를 그대로 돌려준다(긴 문서 → 주제별 분할)', () => {
    const out = parseOrganized('{"pages":[{"title":"A","body":"1"},{"slug":"old","title":"B","body":"2"}]}');
    expect(out).toHaveLength(2);
    expect(out?.[1].slug).toBe('old');
  });

  it('제목·본문이 빈 항목은 버린다', () => {
    const out = parseOrganized('{"pages":[{"title":"","body":"x"},{"title":"ok","body":"y"}]}');
    expect(out).toEqual([{ slug: undefined, title: 'ok', category: undefined, body: 'y' }]);
  });

  it('형태가 아니면 null(호출부가 실패로 기록한다)', () => {
    expect(parseOrganized('그냥 잡담')).toBeNull();
    expect(parseOrganized('{"pages":[]}')).toBeNull();
    expect(parseOrganized('{"pages":"nope"}')).toBeNull();
    expect(parseOrganized('')).toBeNull();
  });
});

describe('중복 페이지 양산 금지', () => {
  it('실제로 있는 slug면 덧붙이기', () => {
    expect(resolveSlug({ slug: 'deploy-guide', title: 'x', body: 'y' }, new Set(['deploy-guide'])))
      .toEqual({ slug: 'deploy-guide', op: 'append' });
  });

  it('두뇌가 지어낸 없는 slug면 신규로 강등(제목 기반 slug)', () => {
    expect(resolveSlug({ slug: 'ghost', title: '새 주제', body: 'y' }, new Set()))
      .toEqual({ slug: '새-주제', op: 'create' });
  });

  it('slug가 없으면 신규', () => {
    expect(resolveSlug({ title: 'New Topic', body: 'y' }, new Set(['other'])))
      .toEqual({ slug: 'new-topic', op: 'create' });
  });
});
