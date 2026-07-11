# Phase 15c — 동시 쓰기 자동 병합 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 두 두뇌가 같은 위키 페이지를 동시에 편집해 충돌할 때, git pull이 abort하는 대신 자동 병합(frontmatter 규칙 조정 + 본문 3-way, 진짜 겹침만 두뇌/union)한다.

**Architecture:** 순수 `page-merge.ts`(frontmatter 규칙·union)와 WikiGit.pull의 충돌 해결(인덱스 스테이지 base/ours/theirs를 꺼내 frontmatter 조정 + `git merge-file` 본문 3-way, 겹치면 주입된 두뇌 병합기 → 실패 시 union)로 구성. 두뇌 병합기는 main.ts가 기본 두뇌로 배선(옵셔널). 해결 실패 시 15b의 abort+로컬유지가 최후 안전망.

**Tech Stack:** NestJS + TypeScript + `simple-git`(백엔드, Jest). 신규 의존성 없음.

## Global Constraints

- **하위호환·안전**: bodyMerger 미주입 → union으로도 자동 해결(두뇌 없이). resolveConflicts 예외 → `git merge --abort` + `{ok:true, conflict:true}`(15b 폴백). **sync 루프는 어떤 경우에도 안 깨진다.**
- **무손실 핵심**: `sources`=합집합, 본문 진짜 겹침 → 두뇌 실패 시 union(양쪽 다 보존). 두뇌 병합의 무손실은 자동 검증 불가(정직히 감수, union이 안전망).
- **저장소 전역 뮤텍스(15b)** 안에서 해결 실행 — 동시 쓰기와 인터리브 안 함. `resolveConflicts`는 `commitAll`(serialize 래핑됨)을 부르지 말고 `this.git.add`/`commit`을 **직접** 호출(pullInner 내부=이미 뮤텍스 보유, 중첩 serialize 데드락 회피).
- **위키 페이지만** 해결(`.md`). 그 외 충돌 파일이 남으면 안전하게 abort.
- 백엔드 테스트: `npx jest <path>` · 백엔드 빌드: `npm run build`

## File Structure

| 파일 | 책임 | 변경 |
|------|------|------|
| `src/knowledge-core/wiki/page-merge.ts` | frontmatter 조정·union 순수 | (신규) |
| `src/knowledge-core/wiki/wiki-git.ts` | pull 충돌 해결 | resolveConflicts + setBodyMerger |
| `src/knowledge-core/wiki/wiki-merge.ts` | 두뇌 병합기 팩토리 | (신규) |
| `prompts/wiki-merge.md` | 병합 프롬프트 | (신규) |
| `src/main.ts` | 상주 부트스트랩 | 기본 두뇌 → bodyMerger 배선 |
| `README.md` | 문서 | 자동 병합 안내 |

---

## Task 1: 순수 병합 로직

**Files:**
- Create: `src/knowledge-core/wiki/page-merge.ts`
- Test: `src/knowledge-core/wiki/page-merge.spec.ts`

**Interfaces:**
- Produces:
  - `reconcileFrontmatter(ours: PageFrontmatter, theirs: PageFrontmatter): PageFrontmatter` — updated=max·created=min·sources=합집합dedup·status=published우선·title/category=updated 최신 쪽(동률 ours).
  - `unionBodies(oursBody: string, theirsBody: string): string` — 다르면 둘 보존(구분자), 같으면 하나.

- [ ] **Step 1: 실패 테스트 작성**

`src/knowledge-core/wiki/page-merge.spec.ts`:

```ts
import { reconcileFrontmatter, unionBodies } from './page-merge';
import { PageFrontmatter } from './page.types';

const fm = (o: Partial<PageFrontmatter>): PageFrontmatter => ({
  title: 'T', category: 'C', status: 'draft', sources: [], created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z', ...o,
});

describe('reconcileFrontmatter', () => {
  it('updated=max, created=min', () => {
    const r = reconcileFrontmatter(
      fm({ updated: '2026-01-02T00:00:00Z', created: '2026-01-01T00:00:00Z' }),
      fm({ updated: '2026-01-03T00:00:00Z', created: '2025-12-31T00:00:00Z' }),
    );
    expect(r.updated).toBe('2026-01-03T00:00:00Z');
    expect(r.created).toBe('2025-12-31T00:00:00Z');
  });
  it('sources=합집합 dedup(순서보존)', () => {
    expect(reconcileFrontmatter(fm({ sources: ['a', 'b'] }), fm({ sources: ['b', 'c'] })).sources).toEqual(['a', 'b', 'c']);
  });
  it('status=둘 중 published 우선', () => {
    expect(reconcileFrontmatter(fm({ status: 'draft' }), fm({ status: 'published' })).status).toBe('published');
    expect(reconcileFrontmatter(fm({ status: 'draft' }), fm({ status: 'draft' })).status).toBe('draft');
  });
  it('title/category=updated 최신 쪽', () => {
    const r = reconcileFrontmatter(
      fm({ title: 'Old', category: 'OldC', updated: '2026-01-01T00:00:00Z' }),
      fm({ title: 'New', category: 'NewC', updated: '2026-01-02T00:00:00Z' }),
    );
    expect(r.title).toBe('New');
    expect(r.category).toBe('NewC');
  });
});

describe('unionBodies', () => {
  it('다르면 둘 다 보존', () => {
    const u = unionBodies('AAA', 'BBB');
    expect(u).toContain('AAA');
    expect(u).toContain('BBB');
  });
  it('같으면 하나', () => {
    expect(unionBodies('same', 'same')).toBe('same');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/knowledge-core/wiki/page-merge.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`src/knowledge-core/wiki/page-merge.ts`:

```ts
import { PageFrontmatter } from './page.types';

// 두 편집을 규칙으로 조정(결정론적). 동시 편집 충돌 시 frontmatter를 합친다.
export function reconcileFrontmatter(ours: PageFrontmatter, theirs: PageFrontmatter): PageFrontmatter {
  const newer = theirs.updated > ours.updated ? theirs : ours; // ISO 문자열 비교. 동률이면 ours.
  return {
    title: newer.title,
    category: newer.category,
    // 지식 가시성 유지 — 한쪽이라도 published면 published.
    status: ours.status === 'published' || theirs.status === 'published' ? 'published' : 'draft',
    sources: [...new Set([...ours.sources, ...theirs.sources])], // 순서보존 dedup — 무손실
    created: ours.created < theirs.created ? ours.created : theirs.created, // 최초
    updated: ours.updated > theirs.updated ? ours.updated : theirs.updated, // 최신
  };
}

// 진짜 본문 겹침의 폴백: 양쪽 다 보존(손실 0). 같으면 하나.
export function unionBodies(oursBody: string, theirsBody: string): string {
  if (oursBody.trim() === theirsBody.trim()) return oursBody;
  return `${oursBody}\n\n<!-- merge: 동시 편집 양쪽 보존 -->\n\n${theirsBody}`;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/knowledge-core/wiki/page-merge.spec.ts`
Expected: PASS (6건).

- [ ] **Step 5: 커밋**

```bash
git add src/knowledge-core/wiki/page-merge.ts src/knowledge-core/wiki/page-merge.spec.ts
git commit -m "feat(phase15c): 페이지 병합 순수 로직 — frontmatter 조정·본문 union"
```

---

## Task 2: WikiGit 충돌 해결

**Files:**
- Modify: `src/knowledge-core/wiki/wiki-git.ts`
- Test: `src/knowledge-core/wiki/wiki-git-remote.spec.ts` (기존 파일에 추가)

**Interfaces:**
- Consumes: `reconcileFrontmatter`/`unionBodies`(Task 1), `parsePage`/`serializePage`(page-serializer), 15b의 `pull`/`serialize`/`pullInner`.
- Produces:
  - `setBodyMerger(fn: (oursBody: string, theirsBody: string) => Promise<string | null>): void`.
  - `pull`이 충돌 시 abort 대신 **자동 해결**: frontmatter 조정 + 본문 3-way(겹침→bodyMerger→union) + 커밋 → `{ok:true, conflict:false}`. 해결 예외 → abort + `{ok:true, conflict:true}`.

- [ ] **Step 1: 실패 테스트 작성**

`src/knowledge-core/wiki/wiki-git-remote.spec.ts`에 헬퍼와 describe 추가(파일 기존 `writePage`/`readPage`/`remote`/`gitA`/`gitB`/`beforeEach` 재사용). 정식 페이지(frontmatter+본문)를 쓰는 헬퍼를 추가:

```ts
// frontmatter + 본문을 gray-matter 포맷으로 직접 쓴다(WikiEngine 없이).
async function writeFullPage(dataDir: string, slug: string, opts: { title?: string; updated?: string; sources?: string[]; body: string }): Promise<void> {
  const pagesDir = path.join(dataDir, 'wiki', 'pages', 'default');
  await fs.promises.mkdir(pagesDir, { recursive: true });
  const fmYaml = [
    '---',
    `title: ${opts.title ?? 'T'}`,
    'category: C',
    'status: published',
    `sources:${opts.sources && opts.sources.length ? '\n' + opts.sources.map((s) => `  - ${s}`).join('\n') : ' []'}`,
    'created: 2026-01-01T00:00:00.000Z',
    `updated: ${opts.updated ?? '2026-01-01T00:00:00.000Z'}`,
    '---',
    opts.body,
    '',
  ].join('\n');
  await fs.promises.writeFile(path.join(pagesDir, `${slug}.md`), fmYaml);
}
function readBody(dataDir: string, slug: string): string {
  const raw = fs.readFileSync(path.join(dataDir, 'wiki', 'pages', 'default', `${slug}.md`), 'utf8');
  return raw.split('---').slice(2).join('---').trim(); // frontmatter 뒤 본문
}

describe('WikiGit 동시 편집 자동 병합', () => {
  // (상위 describe의 beforeEach가 remote/dirA/dirB/gitA/gitB를 준비한다고 가정)
  it('본문 다른 줄 편집 + frontmatter 다름 → 깨끗 병합(양쪽 다 있음, conflict:false)', async () => {
    // base: 5줄
    await writeFullPage(dirA, 'p', { body: 'L1\nL2\nL3\nL4\nL5', updated: '2026-01-01T00:00:00.000Z', sources: ['s0'] });
    await gitA.ensureRemote(remote); await gitA.commitAll('base'); await gitA.push('main');
    await gitB.ensureRemote(remote); await gitB.pull('main');
    // A는 L1, B는 L5 편집 + 각자 다른 source/updated
    await writeFullPage(dirA, 'p', { body: 'A1\nL2\nL3\nL4\nL5', updated: '2026-01-02T00:00:00.000Z', sources: ['s0', 'sA'] });
    await gitA.commitAll('a'); await gitA.push('main');
    await writeFullPage(dirB, 'p', { body: 'L1\nL2\nL3\nL4\nB5', updated: '2026-01-03T00:00:00.000Z', sources: ['s0', 'sB'] });
    await gitB.commitAll('b');
    const pr = await gitB.pull('main');
    expect(pr).toEqual({ ok: true, conflict: false });
    const body = readBody(dirB, 'p');
    expect(body).toContain('A1'); // A의 편집
    expect(body).toContain('B5'); // B의 편집 — 둘 다 보존
    // push까지 되어 A도 pull하면 동일
    await gitB.push('main');
    await gitA.pull('main');
    expect(readBody(dirA, 'p')).toContain('A1');
    expect(readBody(dirA, 'p')).toContain('B5');
  });

  it('같은 줄 겹침 + bodyMerger 미주입 → union(양쪽 다 보존, conflict:false)', async () => {
    await writeFullPage(dirA, 'p', { body: 'base-line', updated: '2026-01-01T00:00:00.000Z' });
    await gitA.ensureRemote(remote); await gitA.commitAll('base'); await gitA.push('main');
    await gitB.ensureRemote(remote); await gitB.pull('main');
    await writeFullPage(dirA, 'p', { body: 'AAA-line', updated: '2026-01-02T00:00:00.000Z' });
    await gitA.commitAll('a'); await gitA.push('main');
    await writeFullPage(dirB, 'p', { body: 'BBB-line', updated: '2026-01-03T00:00:00.000Z' });
    await gitB.commitAll('b');
    const pr = await gitB.pull('main');
    expect(pr.conflict).toBe(false);
    const body = readBody(dirB, 'p');
    expect(body).toContain('AAA-line');
    expect(body).toContain('BBB-line'); // union — 손실 0
  });

  it('같은 줄 겹침 + bodyMerger 주입 → 그 출력이 병합 결과', async () => {
    gitB.setBodyMerger(async () => 'MERGED-BY-BRAIN');
    await writeFullPage(dirA, 'p', { body: 'base', updated: '2026-01-01T00:00:00.000Z' });
    await gitA.ensureRemote(remote); await gitA.commitAll('base'); await gitA.push('main');
    await gitB.ensureRemote(remote); await gitB.pull('main');
    await writeFullPage(dirA, 'p', { body: 'AAA', updated: '2026-01-02T00:00:00.000Z' });
    await gitA.commitAll('a'); await gitA.push('main');
    await writeFullPage(dirB, 'p', { body: 'BBB', updated: '2026-01-03T00:00:00.000Z' });
    await gitB.commitAll('b');
    await gitB.pull('main');
    expect(readBody(dirB, 'p')).toContain('MERGED-BY-BRAIN');
  });

  it('bodyMerger가 null 반환(두뇌 실패 모사) → union 폴백', async () => {
    gitB.setBodyMerger(async () => null);
    await writeFullPage(dirA, 'p', { body: 'base', updated: '2026-01-01T00:00:00.000Z' });
    await gitA.ensureRemote(remote); await gitA.commitAll('base'); await gitA.push('main');
    await gitB.ensureRemote(remote); await gitB.pull('main');
    await writeFullPage(dirA, 'p', { body: 'AAA', updated: '2026-01-02T00:00:00.000Z' });
    await gitA.commitAll('a'); await gitA.push('main');
    await writeFullPage(dirB, 'p', { body: 'BBB', updated: '2026-01-03T00:00:00.000Z' });
    await gitB.commitAll('b');
    await gitB.pull('main');
    const body = readBody(dirB, 'p');
    expect(body).toContain('AAA');
    expect(body).toContain('BBB');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/knowledge-core/wiki/wiki-git-remote.spec.ts`
Expected: FAIL — 충돌이 자동 해결되지 않고 `{conflict:true}` 반환(15b) / `setBodyMerger` 없음.

- [ ] **Step 3: 구현**

`src/knowledge-core/wiki/wiki-git.ts`:

(a) import 추가(상단):
```ts
import * as os from 'os';
import * as path from 'path';
import { parsePage, serializePage } from './page-serializer';
import { reconcileFrontmatter, unionBodies } from './page-merge';
```
(`fs`는 이미 `import * as fs from 'fs/promises'` 존재.)

(b) 필드 + setter(클래스 상단):
```ts
  private bodyMerger?: (oursBody: string, theirsBody: string) => Promise<string | null>;
  // 진짜 본문 겹침일 때 쓸 두뇌 병합기 주입(옵셔널 — 미주입 시 union 폴백).
  setBodyMerger(fn: (oursBody: string, theirsBody: string) => Promise<string | null>): void {
    this.bodyMerger = fn;
  }
```

(c) `pullInner`(15b)의 충돌 처리 교체 — 기존:
```ts
      if (status.conflicted.length > 0) {
        await this.git.raw(['merge', '--abort']).catch(() => {});
        return { ok: true, conflict: true }; // 내용 충돌 → 로컬 유지
      }
```
를 아래로:
```ts
      if (status.conflicted.length > 0) {
        return await this.resolveConflicts(); // 15c: abort 대신 자동 병합
      }
```

(d) 해결 메서드 추가(private, 클래스 하단):
```ts
  // 충돌한 위키 페이지들을 자동 병합(15c). frontmatter 규칙 + 본문 3-way(겹침→두뇌/union).
  // 실패 시 abort로 되돌려(15b) 안전 유지 — sync 루프 불사.
  // 주의: commitAll(serialize 래핑)을 부르지 않고 git.add/commit을 직접 호출(이미 pullInner=뮤텍스 내부).
  private async resolveConflicts(): Promise<{ ok: boolean; conflict: boolean }> {
    try {
      const status = await this.git.status();
      for (const rel of status.conflicted) {
        if (!rel.endsWith('.md')) continue; // 위키 페이지만
        await this.resolveOnePage(rel);
      }
      const after = await this.git.status();
      if (after.conflicted.length > 0) { // .md 아닌 충돌이 남음 → 안전 abort
        await this.git.raw(['merge', '--abort']).catch(() => {});
        return { ok: true, conflict: true };
      }
      await this.git.commit('merge: reconcile concurrent wiki edits');
      return { ok: true, conflict: false };
    } catch {
      await this.git.raw(['merge', '--abort']).catch(() => {}); // 해결 실패 → 15b 폴백
      return { ok: true, conflict: true };
    }
  }

  private async resolveOnePage(rel: string): Promise<void> {
    const slug = path.basename(rel, '.md');
    const oursRaw = await this.showStage(2, rel);
    const theirsRaw = await this.showStage(3, rel);
    if (oursRaw == null || theirsRaw == null) throw new Error(`stage 없음: ${rel}`); // → 상위 catch가 abort
    const ours = parsePage(slug, oursRaw);
    const theirs = parsePage(slug, theirsRaw);
    const frontmatter = reconcileFrontmatter(ours.frontmatter, theirs.frontmatter);
    const baseRaw = await this.showStage(1, rel); // 없을 수 있음(add/add)
    const baseBody = baseRaw != null ? parsePage(slug, baseRaw).body : '';
    const body = await this.mergeBody(baseBody, ours.body, theirs.body);
    const merged = serializePage({ slug, frontmatter, body });
    await fs.writeFile(path.join(this.paths.getWikiDir(), rel), merged, 'utf8');
    await this.git.add(rel);
  }

  // 인덱스 스테이지(1=base,2=ours,3=theirs)의 파일 내용. 없으면 null.
  private async showStage(stage: 1 | 2 | 3, rel: string): Promise<string | null> {
    return this.git.raw(['show', `:${stage}:${rel}`]).then((s) => s).catch(() => null);
  }

  // 본문 3-way. 깨끗하면 병합본문, 진짜 겹침이면 bodyMerger→union.
  private async mergeBody(baseBody: string, oursBody: string, theirsBody: string): Promise<string> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-bodymerge-'));
    try {
      const o = path.join(tmp, 'o'), b = path.join(tmp, 'b'), t = path.join(tmp, 't');
      await fs.writeFile(o, oursBody); await fs.writeFile(b, baseBody); await fs.writeFile(t, theirsBody);
      // git merge-file -p -q <ours> <base> <theirs> → stdout. 충돌 시 마커 포함(또는 non-zero exit로 throw).
      let merged: string | null = null;
      try { merged = await this.git.raw(['merge-file', '-p', '-q', o, b, t]); } catch { merged = null; }
      if (merged != null && !merged.includes('<<<<<<<')) return merged; // 깨끗
      // 진짜 겹침 → 두뇌 병합 시도 → 실패/미주입 시 union
      if (this.bodyMerger) {
        const m = await this.bodyMerger(oursBody, theirsBody).catch(() => null);
        if (m && m.trim()) return m;
      }
      return unionBodies(oursBody, theirsBody);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/knowledge-core/wiki/wiki-git-remote.spec.ts`
Expected: PASS (기존 + 신규 4건). 기존 15b 충돌 테스트("같은 페이지 다른 편집 동시 → pull 충돌 시 abort")는 **동작이 바뀐다**(이제 자동 병합) — 그 테스트를 15c 동작으로 갱신하거나 신규가 대체함. 갱신 시 "충돌→abort" 단언을 "충돌→병합(conflict:false, 양쪽 보존)"으로 바꾼다.

- [ ] **Step 5: 회귀 + 커밋**

Run: `npx jest src/knowledge-core/wiki`
Expected: PASS (전체 wiki).

```bash
git add src/knowledge-core/wiki/wiki-git.ts src/knowledge-core/wiki/wiki-git-remote.spec.ts
git commit -m "feat(phase15c): WikiGit pull 충돌 자동 병합 — frontmatter 조정+본문 3-way+두뇌/union, setBodyMerger"
```

---

## Task 3: 두뇌 병합기 + 프롬프트 + 배선

**Files:**
- Create: `src/knowledge-core/wiki/wiki-merge.ts`
- Create: `prompts/wiki-merge.md`
- Modify: `src/main.ts`
- Test: `src/knowledge-core/wiki/wiki-merge.spec.ts` (Create)

**Interfaces:**
- Consumes: `WikiGit.setBodyMerger`(Task 2), 기본 두뇌(`BRAIN`), 프롬프트.
- Produces: `makeBrainBodyMerger(brain, promptTemplate): (oursBody, theirsBody) => Promise<string | null>` — 두뇌 호출, `isError`/빈 출력 → `null`(→union 폴백).

- [ ] **Step 1: 실패 테스트 작성**

`src/knowledge-core/wiki/wiki-merge.spec.ts`:

```ts
import { makeBrainBodyMerger } from './wiki-merge';

const tmpl = 'MERGE\nOURS:\n{{OURS}}\nTHEIRS:\n{{THEIRS}}';

describe('makeBrainBodyMerger', () => {
  it('두뇌 출력을 반환(프롬프트에 두 본문 주입)', async () => {
    let seen = '';
    const brain = { complete: async (p: string) => { seen = p; return { text: 'MERGED', isError: false }; } };
    const merger = makeBrainBodyMerger(brain, tmpl);
    expect(await merger('AAA', 'BBB')).toBe('MERGED');
    expect(seen).toContain('AAA');
    expect(seen).toContain('BBB');
  });
  it('isError → null(union 폴백 유도)', async () => {
    const brain = { complete: async () => ({ text: 'x', isError: true }) };
    expect(await makeBrainBodyMerger(brain, tmpl)('a', 'b')).toBeNull();
  });
  it('빈 출력 → null', async () => {
    const brain = { complete: async () => ({ text: '   ', isError: false }) };
    expect(await makeBrainBodyMerger(brain, tmpl)('a', 'b')).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/knowledge-core/wiki/wiki-merge.spec.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 구현**

`src/knowledge-core/wiki/wiki-merge.ts`:

```ts
// 두뇌 기반 본문 병합기 팩토리(15c). WikiGit.setBodyMerger에 주입.
// 두뇌 모듈에 직접 의존하지 않게 구조적 타입만 받는다.
interface BrainLike {
  complete(prompt: string): Promise<{ text: string; isError: boolean }>;
}

export function makeBrainBodyMerger(
  brain: BrainLike,
  promptTemplate: string,
): (oursBody: string, theirsBody: string) => Promise<string | null> {
  return async (oursBody, theirsBody) => {
    const prompt = promptTemplate.replace('{{OURS}}', oursBody).replace('{{THEIRS}}', theirsBody);
    const r = await brain.complete(prompt);
    const t = r.isError ? '' : r.text.trim();
    return t ? t : null; // 실패/빈 출력 → null → 호출자가 union 폴백
  };
}
```

`prompts/wiki-merge.md`:
```markdown
다음은 한 위키 페이지 본문의 두 버전이다(동시 편집으로 충돌). 어느 사실도 빠뜨리지 말고 하나의 일관된 마크다운 본문으로 합쳐라. 중복은 정리하되 내용은 보존하라. 마크다운 본문만 출력하고 설명은 쓰지 마라.

=== 버전 A ===
{{OURS}}

=== 버전 B ===
{{THEIRS}}
```

- [ ] **Step 4: 테스트 통과 + main.ts 배선**

Run: `npx jest src/knowledge-core/wiki/wiki-merge.spec.ts`
Expected: PASS (3건).

`src/main.ts` — import 추가:
```ts
import { BRAIN } from './brain/brain.port';
import { makeBrainBodyMerger } from './knowledge-core/wiki/wiki-merge';
import { loadPrompt } from './agent-layer/prompt-store';
import type { BrainProvider } from './brain/brain.port';
```
(`loadPrompt(name, fallback)` — 2인자, `prompts/{name}.md`를 읽고 없으면 fallback. 기존 호출부[insight-reporter 등]와 동일.)

15b의 위키 원격 배선 블록(`if (wikiRemote) { ... }`) 안에서, WikiSyncService 생성/start **직전**에 두뇌 병합기 주입:
```ts
  if (wikiRemote) {
    const wikiGit = app.get(WikiGit);
    try {
      const brain = app.get<BrainProvider>(BRAIN);
      const mergePrompt = loadPrompt('wiki-merge', WIKI_MERGE_FALLBACK);
      wikiGit.setBodyMerger(makeBrainBodyMerger(brain, mergePrompt));
    } catch (e) {
      logger.warn(`위키 병합 두뇌 배선 실패(union 폴백): ${String(e)}`, 'WikiSync');
    }
    const wikiSync = new WikiSyncService(wikiGit, wikiRemote, logger);
    void wikiSync.start().catch((e) => logger.warn(`위키 동기화 시작 실패: ${String(e)}`, 'WikiSync'));
  }
```
- `BrainProvider`/`BRAIN` import는 `./brain/brain.port`.
- `WIKI_MERGE_FALLBACK` = 내장 기본 프롬프트 문자열(위 prompts/wiki-merge.md와 동일 내용) — loadPrompt의 fallback 인자. prompt-store 관례.
- 두뇌 배선 실패는 삼킨다(union 폴백으로 계속). `app.get(WikiGit)`는 한 번만 호출해 재사용.

- [ ] **Step 5: 빌드 + 회귀**

Run: `npm run build`
Expected: nest build exit 0.
Run: `npm test`
Expected: 전체 녹색.

- [ ] **Step 6: 커밋**

```bash
git add src/knowledge-core/wiki/wiki-merge.ts src/knowledge-core/wiki/wiki-merge.spec.ts prompts/wiki-merge.md src/main.ts
git commit -m "feat(phase15c): 두뇌 본문 병합기 + 프롬프트 + main 배선(union 폴백)"
```

---

## Task 4: 문서(README)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 충돌 안내 갱신**

`README.md`의 "위키 중앙 저장 (Phase 15b)" 절 마지막 ⚠️ 충돌 항목을 아래로 교체(또는 뒤에 추가):

```markdown
- **같은 페이지 동시 편집도 자동 병합된다(Phase 15c)**: frontmatter는 규칙으로 조정(최신 시각·
  출처 합집합·published 우선), 본문은 3-way 병합(서로 다른 곳 추가는 깨끗이 합쳐짐). 같은 줄을
  양쪽이 다르게 고친 진짜 겹침만 기본 두뇌가 합치고, 두뇌가 없거나 실패하면 양쪽을 모두 보존
  (union)한다 — 지식은 사라지지 않고 sync는 안 깨진다.
```

- [ ] **Step 2: 커밋**

```bash
git add README.md
git commit -m "docs(phase15c): 동시 편집 자동 병합 안내"
```

---

## 완료 검증(전 태스크 후)

- [ ] 백엔드 전체: `npm test` → 녹색
- [ ] 빌드: `npm run build` → exit 0
- [ ] 수동 스모크(선택): bare 원격 + 두 데이터 폴더로 같은 페이지를 서로 다르게 편집·커밋 후 양쪽
  pull → 두 편집이 한 페이지에 합쳐지는지(frontmatter 조정·본문 둘 다) 확인.

---

## Self-Review 결과

- **스펙 커버리지**: §2.1 순수 병합=Task1 / §2.2 resolveConflicts(스테이지·frontmatter·본문 3-way·두뇌/union·commit·abort 폴백)=Task2 / §2.3 두뇌 병합기·프롬프트·배선=Task3 / §3 README=Task4 / §4 테스트=각 태스크. 갭 없음.
- **타입 정합**: `reconcileFrontmatter(ours, theirs)`·`unionBodies`(Task1)를 Task2가 소비 · `setBodyMerger(fn)`·`(oursBody,theirsBody)=>Promise<string|null>`(Task2)를 Task3 makeBrainBodyMerger가 만족 · `BrainLike.complete`(Task3)를 main의 `app.get(BRAIN)`가 만족(BrainResult에 text·isError 존재). 일치.
  - **스펙 편차(의도)**: `reconcileFrontmatter`에서 `base` 파라미터를 뺐다 — 규칙(max/min/합집합)이 전부 ours/theirs 쌍대라 base 불필요. base는 본문 3-way(`mergeBody`)에만 쓰이고 그쪽은 유지.
- **하위호환·안전**: bodyMerger 미주입/두뇌 실패 → union(무손실). resolveConflicts 예외 → abort+conflict:true(15b). 뮤텍스 내부 실행·commitAll 미호출(직접 add/commit)로 데드락 회피.
- **주의(Task2 Step4)**: 기존 15b "충돌→abort" 테스트는 15c에서 동작이 바뀌므로 갱신 필요(신규 테스트가 대체). 구현자가 그 단언을 15c 동작으로 갱신.
