import { createStreamFenceGuard } from './stream-fence-guard';

// 스트리밍 펜스 가드: 델타를 UI로 흘리기 전에 통과하는 필터.
// ```ask_user / ```engram:propose 는 "확정 전 원시 JSON"이 화면에 잠깐 보이면 안 되는 특수 블록이라
// 열리는 순간부터 보류하고 닫히면 통째로 버린다. 반대로 일반 코드블록·```html·```chart는 정상 통과해야
// 한다(HTML 인라인 미리보기가 이걸 쓴다). 판정 불가한 꼬리는 판정될 때까지만 보류한다.
describe('stream-fence-guard — 특수 펜스만 삼키는 표시용 가드', () => {
  // 여러 조각으로 흘려넣고 방출된 텍스트를 이어붙인다(가드는 증분 in/증분 out).
  const run = (chunks: string[]): string => {
    const g = createStreamFenceGuard();
    return chunks.map((c) => g.push(c)).join('');
  };

  describe('평문·일반 펜스는 그대로 흐른다', () => {
    it('펜스 없는 평문은 조각 그대로 방출한다', () => {
      expect(run(['안녕', '하세', '요'])).toBe('안녕하세요');
    });

    it('일반 코드블록(```ts)은 통째로 흐른다', () => {
      const src = '설명\n```ts\nconst a = 1;\n```\n끝';
      expect(run([src])).toBe(src);
    });

    it('```html 블록은 흐른다(인라인 미리보기가 이걸 쓴다)', () => {
      const src = '보세요\n```html\n<p>hi</p>\n```\n';
      expect(run([src])).toBe(src);
    });

    it('```chart 블록도 흐른다', () => {
      const src = '```chart\n{"type":"bar"}\n```\n';
      expect(run([src])).toBe(src);
    });

    it('토큰 단위로 쪼개 들어와도 최종 방출 총합은 원문과 같다', () => {
      const src = '앞\n```html\n<b>x</b>\n```\n뒤\n';
      expect(run(src.split(''))).toBe(src);
    });
  });

  describe('특수 펜스는 열리는 즉시 보류하고 닫히면 버린다', () => {
    it('```ask_user 블록은 화면에 한 글자도 새지 않는다', () => {
      const out = run(['답이에요.\n', '```ask_user\n', '{"questions":[]}\n', '```\n', '뒤 텍스트']);
      expect(out).not.toContain('ask_user');
      expect(out).not.toContain('questions');
      expect(out).toContain('답이에요.');
      expect(out).toContain('뒤 텍스트');
    });

    it('```engram:propose 블록도 버린다(코드 채널 제안 마커)', () => {
      const out = run(['고칠게요.\n```engram:propose\n{"goal":"x"}\n```']);
      expect(out).toBe('고칠게요.\n');
    });

    it('한 글자씩 흘려도 특수 펜스 내용은 새지 않는다', () => {
      const src = 'A\n```ask_user\n{"questions":[{"q":"?"}]}\n```\nB';
      const out = run(src.split(''));
      expect(out).not.toContain('"q"');
      expect(out).not.toContain('ask_user');
      expect(out.replace(/\s/g, '')).toBe('AB');
    });

    it('특수 펜스가 안 닫힌 채 스트림이 끝나면 그 뒤는 전부 보류된 채로 남는다', () => {
      const out = run(['앞\n', '```ask_user\n', '{"questio']);
      expect(out).toBe('앞\n');
    });
  });

  describe('판정 불가 꼬리는 판정될 때까지만 보류한다', () => {
    it('줄 끝의 ```만 온 상태는 보류했다가 일반 펜스로 판정되면 즉시 방출한다', () => {
      const g = createStreamFenceGuard();
      expect(g.push('앞\n```')).toBe('앞\n'); // ```의 정체(info string)를 아직 모른다 → 보류
      expect(g.push('html\n')).toBe('```html\n'); // 일반 펜스 확정 → 밀린 것까지 한 번에
    });

    it('```ask 까지만 온 상태도 보류한다(ask_user일 수 있다)', () => {
      const g = createStreamFenceGuard();
      expect(g.push('```ask')).toBe('');
    });

    it('특수 펜스가 아님이 확정되는 첫 글자에서 바로 방출한다(무한 보류 금지)', () => {
      const g = createStreamFenceGuard();
      expect(g.push('```as')).toBe(''); // ask_user 후보
      expect(g.push('m')).toBe('```asm'); // 'asm' — 후보 탈락 확정 → 즉시
    });

    it('```e 는 engram:propose 후보라 보류, 다른 글자가 오면 방출한다', () => {
      const g = createStreamFenceGuard();
      expect(g.push('```e')).toBe('');
      expect(g.push('lixir\n')).toBe('```elixir\n');
    });

    it('백틱 1~2개짜리 꼬리도 보류했다가 펜스가 아니면 방출한다', () => {
      const g = createStreamFenceGuard();
      expect(g.push('값은 `')).toBe('값은 ');
      expect(g.push('x` 입니다')).toBe('`x` 입니다');
    });
  });

  describe('경계·안전', () => {
    it('빈 문자열 push는 빈 문자열을 돌려준다', () => {
      const g = createStreamFenceGuard();
      expect(g.push('')).toBe('');
    });

    it('특수 펜스가 닫힌 뒤의 일반 펜스는 다시 정상적으로 흐른다', () => {
      const out = run(['```ask_user\n{}\n```\n', '```html\n<i>a</i>\n```\n']);
      expect(out).toContain('```html');
      expect(out).toContain('<i>a</i>');
      expect(out).not.toContain('ask_user');
    });

    it('연달아 두 개의 특수 펜스가 와도 둘 다 삼킨다', () => {
      const out = run(['x\n```ask_user\n{}\n```\ny\n```engram:propose\n{}\n```\nz']);
      expect(out.replace(/\s/g, '')).toBe('xyz');
    });

    it('info string에 공백이 붙어도(```ask_user  ) 특수 펜스로 본다', () => {
      const out = run(['```ask_user  \n{}\n```\n뒤']);
      expect(out.trim()).toBe('뒤');
    });
  });
});
