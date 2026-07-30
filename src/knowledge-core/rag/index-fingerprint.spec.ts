import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexFingerprints, fingerprintOf, keyOf } from './index-fingerprint';

// 부팅마다 전 페이지를 다시 임베딩하던 것을 막는 장치(2026-07-27 실사고: 13장 약 4분, 100장이면 30분).
const page = (over: Partial<Parameters<typeof fingerprintOf>[0]> = {}) => ({
  userId: 'default', slug: 'a', title: 'T', category: 'c', sources: ['mcp'], body: 'body', ...over,
});

describe('fingerprintOf', () => {
  it('같은 내용이면 같은 지문', () => {
    expect(fingerprintOf(page())).toBe(fingerprintOf(page()));
  });

  it('색인 결과를 바꾸는 필드가 바뀌면 지문도 바뀐다', () => {
    const base = fingerprintOf(page());
    expect(fingerprintOf(page({ body: 'body2' }))).not.toBe(base);
    expect(fingerprintOf(page({ title: 'T2' }))).not.toBe(base);
    expect(fingerprintOf(page({ category: 'c2' }))).not.toBe(base);   // 분류는 색인 행에 들어간다
    expect(fingerprintOf(page({ sources: ['x'] }))).not.toBe(base);
  });

  // 경계가 없으면 "제목 T + 본문 body"와 "제목 Tb + 본문 ody"가 같은 지문이 된다.
  it('필드 경계가 섞이지 않는다', () => {
    expect(fingerprintOf(page({ title: 'T', body: 'body' })))
      .not.toBe(fingerprintOf(page({ title: 'Tbody', body: '' })));
  });
});

describe('IndexFingerprints', () => {
  const tmps: string[] = [];
  const newFile = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-fp-'));
    tmps.push(d);
    return path.join(d, 'state', 'rag-index.json');
  };
  afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

  it('저장한 지문은 다시 읽어도 일치한다(부팅 간 유지)', () => {
    const f = newFile();
    const a = new IndexFingerprints(f);
    a.load();
    expect(a.matches(page())).toBe(false); // 처음엔 색인된 적 없음
    a.set(page());
    a.save();

    const b = new IndexFingerprints(f);
    b.load();
    expect(b.matches(page())).toBe(true);
    expect(b.matches(page({ body: 'changed' }))).toBe(false);
  });

  // ★안전측 폴백: 지문을 모르면 "전부 다시 색인"(=예전 동작)이지 "이미 됐다"가 아니다.
  it('파일이 없거나 깨졌으면 아무것도 일치하지 않는다', () => {
    const f = newFile();
    const a = new IndexFingerprints(f);
    a.load();
    expect(a.matches(page())).toBe(false);

    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{ this is not json');
    const b = new IndexFingerprints(f);
    b.load();
    expect(b.matches(page())).toBe(false);
  });

  it('keepOnly로 사라진 페이지의 지문을 정리한다', () => {
    const f = newFile();
    const a = new IndexFingerprints(f);
    a.load();
    a.set(page({ slug: 'a' }));
    a.set(page({ slug: 'b' }));
    a.keepOnly(new Set([keyOf({ userId: 'default', slug: 'a' })]));
    a.save();

    const b = new IndexFingerprints(f);
    b.load();
    expect(b.matches(page({ slug: 'a' }))).toBe(true);
    expect(b.matches(page({ slug: 'b' }))).toBe(false);
  });

  // 격리로 색인이 통째로 사라졌는데 지문이 남아 있으면 "이미 색인됨"으로 오판해 빈 스토어를 둔다.
  it('clear는 파일까지 지운다(격리 후 전부 재색인되게)', () => {
    const f = newFile();
    const a = new IndexFingerprints(f);
    a.load();
    a.set(page());
    a.save();
    expect(fs.existsSync(f)).toBe(true);

    a.clear();
    expect(fs.existsSync(f)).toBe(false);
    const b = new IndexFingerprints(f);
    b.load();
    expect(b.matches(page())).toBe(false);
  });

  it('다른 userId는 다른 키(교차 오염 없음)', () => {
    const f = newFile();
    const a = new IndexFingerprints(f);
    a.load();
    a.set(page({ userId: 'u1' }));
    expect(a.matches(page({ userId: 'u2' }))).toBe(false);
  });
});

// ★2026-07-30 실사고: frontmatter는 `as PageFrontmatter` 캐스트일 뿐 실제 값은 YAML이 준 것이다.
// `title: 2026-07-30`은 Date, 빈 `category:`는 null, 키가 없으면 undefined — crypto.update가
// ERR_INVALID_ARG_TYPE을 던지고 그 throw가 부팅 재색인을 무너뜨려 앱이 영원히 안 켜졌다.
// 앱이 쓴 페이지는 늘 문자열이라 개발 머신에서는 재현되지 않는다(git 동기화·손편집 페이지만 터짐).
describe('fingerprintOf — 문자열이 아닌 frontmatter', () => {
  const odd = (over: Record<string, unknown>) =>
    ({ userId: 'default', slug: 'a', title: 'T', category: 'c', sources: ['mcp'], body: 'b', ...over }) as never;

  it('Date 제목(title: 2026-07-30)에도 던지지 않는다', () => {
    expect(() => fingerprintOf(odd({ title: new Date('2026-07-30') }))).not.toThrow();
  });

  it('null·undefined 분류(빈 category: / 키 없음)에도 던지지 않는다', () => {
    expect(() => fingerprintOf(odd({ category: null }))).not.toThrow();
    expect(() => fingerprintOf(odd({ category: undefined }))).not.toThrow();
  });

  it('숫자 제목(title: 2026)에도 던지지 않는다', () => {
    expect(() => fingerprintOf(odd({ title: 2026 }))).not.toThrow();
  });

  it('null과 undefined와 빈 문자열은 같은 지문(셋 다 "분류 없음")', () => {
    const a = fingerprintOf(odd({ category: null }));
    expect(fingerprintOf(odd({ category: undefined }))).toBe(a);
    expect(fingerprintOf(odd({ category: '' }))).toBe(a);
  });

  it('이상한 값이어도 서로 다르면 지문이 다르다(스킵 오판 금지)', () => {
    expect(fingerprintOf(odd({ title: 2026 }))).not.toBe(fingerprintOf(odd({ title: 2027 })));
  });
});

// ★구분자 고정(2026-07-30). 지문이 바뀌면 업데이트한 사용자 전원이 부팅에서 전 페이지를 다시
// 임베딩한다(13장 약 4분) — 그래서 v0.0.23에 실려 나간 계산과 바이트 단위로 같아야 한다.
// 아래 상수는 그 버전의 코드로 실측한 값이다(직접 계산한 게 아니라 실행해서 얻었다).
it('지문 계산은 이미 배포된 버전과 동일하다(업데이트 시 재색인 0)', () => {
  const shipped = (p: Parameters<typeof fingerprintOf>[0]) => {
    const h = require('crypto').createHash('sha256');
    h.update(p.title).update('\0');
    h.update(p.category).update('\0');
    h.update(JSON.stringify(p.sources ?? [])).update('\0');
    h.update(p.body);
    return h.digest('hex').slice(0, 32);
  };
  const p = { userId: 'default', slug: 'a', title: 'T', category: 'c', sources: ['mcp'], body: 'body' };
  expect(fingerprintOf(p)).toBe(shipped(p));
});
