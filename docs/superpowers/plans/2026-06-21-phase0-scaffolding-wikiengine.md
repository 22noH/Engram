# Phase 0 (Part 1): 프로젝트 스캐폴딩 + WikiEngine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NestJS 프로젝트 골격을 세우고, 출처·상태(draft/published)·git 이력을 갖춘 버전관리형 `WikiEngine`을 구현한다.

**Architecture:** 단일 NestJS 상주 프로세스. `knowledge-core` 모듈 안에 `WikiEngine`(파일 기반 `.md` CRUD)과 `WikiGit`(데이터 디렉토리 git 이력)을 둔다. 경로는 `pal/PathResolver`가 코드/데이터 분리 원칙에 따라 `runtime/` 아래로 해소한다.

**Tech Stack:** Node.js 24(≥22), TypeScript, NestJS 11, Jest(ts-jest), gray-matter(frontmatter), simple-git(이력).

## Global Constraints

(모든 태스크의 요구사항에 암묵적으로 포함된다 — 설계 문서 `docs/DESIGN.md`에서 발췌)

- 런타임: **Node.js ≥ 22**, **TypeScript**, **NestJS**.
- **셸 스크립트 0개.** 모든 로직은 TS로. 빌드/테스트만 npm 스크립트.
- **경로 하드코딩 금지.** 항상 `path` 모듈(`path.join`)로 조합. OS 무관.
- **코드/데이터 분리.** 데이터는 `runtime/`(git 미추적, 이미 `.gitignore`에 있음). 코드는 repo.
- **줄바꿈 LF.** `.gitattributes`에 `* text=auto eol=lf` (이미 존재).
- **한국어 주석.** 모든 클래스/공개 메서드에 목적·설계 이유를 한국어 주석으로(설계 코드 컨벤션).
- DRY · YAGNI · TDD · 잦은 커밋.

---

## File Structure

```
engram/
 ├ package.json                                   # Task 1 (deps, scripts, jest 설정)
 ├ tsconfig.json                                  # Task 1
 ├ nest-cli.json                                  # Task 1
 ├ src/
 │  ├ main.ts                                     # Task 1 (standalone 부트스트랩)
 │  ├ app.module.ts                               # Task 1 생성 → Task 4 수정(모듈 import)
 │  ├ app.module.spec.ts                          # Task 1 (toolchain sanity)
 │  ├ pal/
 │  │  ├ path-resolver.ts                         # Task 2 (runtime/ 경로 해소)
 │  │  └ path-resolver.spec.ts                    # Task 2
 │  └ knowledge-core/
 │     ├ knowledge-core.module.ts                 # Task 4 생성 → Task 6 수정(WikiGit 추가)
 │     └ wiki/
 │        ├ page.types.ts                         # Task 3 (Page/Frontmatter 타입)
 │        ├ page-serializer.ts                    # Task 3 (.md ↔ 객체)
 │        ├ page-serializer.spec.ts               # Task 3
 │        ├ wiki-engine.ts                        # Task 4 생성 → Task 5,6 수정
 │        ├ wiki-engine.spec.ts                   # Task 4 → Task 5 추가
 │        ├ wiki-git.ts                           # Task 6 (git 이력)
 │        └ wiki-git.spec.ts                      # Task 6
 └ runtime/                                        # 데이터(git 미추적). 런타임에 생성됨
```

각 파일은 단일 책임: `PathResolver`=경로, `page-serializer`=직렬화(순수 함수), `WikiEngine`=CRUD/상태, `WikiGit`=이력.

---

### Task 1: 프로젝트 스캐폴딩

NestJS standalone 앱 + Jest 툴체인을 세우고, 모듈이 컴파일되는지 검증한다.

**Files:**
- Create: `package.json`, `tsconfig.json`, `nest-cli.json`, `src/main.ts`, `src/app.module.ts`, `src/app.module.spec.ts`

**Interfaces:**
- Consumes: (없음 — 최초 태스크)
- Produces: `AppModule`(빈 모듈, 이후 태스크가 import 추가), `npm test`/`npm run build` 스크립트.

- [ ] **Step 1: `package.json` 작성**

```json
{
  "name": "engram",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "test": "jest"
  },
  "dependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "gray-matter": "^4.0.3",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "simple-git": "^3.27.0"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0",
    "@nestjs/schematics": "^11.0.0",
    "@nestjs/testing": "^11.0.0",
    "@types/jest": "^29.5.14",
    "@types/node": "^22.10.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.5",
    "ts-node": "^10.9.2",
    "typescript": "^5.7.0"
  },
  "jest": {
    "moduleFileExtensions": ["js", "json", "ts"],
    "rootDir": "src",
    "testRegex": ".*\\.spec\\.ts$",
    "transform": { "^.+\\.ts$": "ts-jest" },
    "testEnvironment": "node"
  }
}
```

- [ ] **Step 2: `tsconfig.json` 작성**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2022",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true
  }
}
```

- [ ] **Step 3: `nest-cli.json` 작성**

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src"
}
```

- [ ] **Step 4: `src/app.module.ts` 작성 (빈 루트 모듈)**

```ts
import { Module } from '@nestjs/common';

// Engram 루트 모듈. 이후 태스크에서 KnowledgeCoreModule 등을 import한다.
@Module({})
export class AppModule {}
```

- [ ] **Step 5: `src/main.ts` 작성 (HTTP 없는 standalone 부트스트랩)**

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// Phase 0 부트스트랩. Gateway(Phase 1)가 붙기 전까지는 HTTP 리스닝 없이
// 모듈 그래프만 구성하는 standalone 컨텍스트로 띄운다.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  await app.init();
}

void bootstrap();
```

- [ ] **Step 6: 실패하는 sanity 테스트 작성 — `src/app.module.spec.ts`**

```ts
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

describe('AppModule', () => {
  it('모듈이 컴파일된다', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    expect(moduleRef).toBeDefined();
  });
});
```

- [ ] **Step 7: 의존성 설치**

Run: `npm install`
Expected: 설치 성공, `node_modules/` 생성.

- [ ] **Step 8: 테스트 실행 → 통과 확인**

Run: `npm test`
Expected: PASS — `AppModule › 모듈이 컴파일된다` 1 passed.

- [ ] **Step 9: 빌드 확인**

Run: `npm run build`
Expected: 에러 없이 `dist/` 생성.

- [ ] **Step 10: 커밋**

```bash
git add package.json tsconfig.json nest-cli.json src/
git commit -m "chore: scaffold NestJS project with jest" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: PathResolver

`runtime/` 데이터 경로를 OS 무관하게 해소한다. 환경변수로 재정의 가능(테스트·배포).

**Files:**
- Create: `src/pal/path-resolver.ts`, `src/pal/path-resolver.spec.ts`

**Interfaces:**
- Consumes: (없음)
- Produces: `class PathResolver`
  - `constructor(baseDir?: string)`
  - `getDataDir(): string`
  - `getWikiDir(): string` → `<dataDir>/wiki`
  - `getWikiPagesDir(): string` → `<dataDir>/wiki/pages`

- [ ] **Step 1: 실패하는 테스트 작성 — `src/pal/path-resolver.spec.ts`**

```ts
import * as path from 'path';
import { PathResolver } from './path-resolver';

describe('PathResolver', () => {
  it('명시적 baseDir를 데이터 디렉토리로 사용한다', () => {
    const r = new PathResolver(path.join('C:', 'tmp', 'engram-test'));
    expect(r.getDataDir()).toBe(path.join('C:', 'tmp', 'engram-test'));
    expect(r.getWikiPagesDir()).toBe(
      path.join('C:', 'tmp', 'engram-test', 'wiki', 'pages'),
    );
  });

  it('baseDir 미지정 시 cwd/runtime을 기본값으로 쓴다', () => {
    delete process.env.ENGRAM_DATA_DIR;
    const r = new PathResolver();
    expect(r.getDataDir()).toBe(path.join(process.cwd(), 'runtime'));
  });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npx jest src/pal/path-resolver.spec.ts`
Expected: FAIL — `Cannot find module './path-resolver'`.

- [ ] **Step 3: 구현 — `src/pal/path-resolver.ts`**

```ts
import { Injectable } from '@nestjs/common';
import * as path from 'path';

// 데이터 디렉토리(runtime/) 경로 해소기.
// 설계 §3 "코드/데이터 분리": 위키·RAG·상태가 모두 이 아래에 위치한다.
// 우선순위: 생성자 인자 > 환경변수(ENGRAM_DATA_DIR) > <cwd>/runtime.
// (배포 시 %APPDATA%/engram 등으로의 확장은 이후 단계의 책임)
@Injectable()
export class PathResolver {
  private readonly dataDir: string;

  constructor(baseDir?: string) {
    this.dataDir =
      baseDir ??
      process.env.ENGRAM_DATA_DIR ??
      path.join(process.cwd(), 'runtime');
  }

  getDataDir(): string {
    return this.dataDir;
  }

  // 위키 데이터 루트(여기서 git 이력을 관리한다).
  getWikiDir(): string {
    return path.join(this.dataDir, 'wiki');
  }

  // 위키 페이지(.md) 디렉토리.
  getWikiPagesDir(): string {
    return path.join(this.getWikiDir(), 'pages');
  }
}
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `npx jest src/pal/path-resolver.spec.ts`
Expected: PASS — 2 passed.

- [ ] **Step 5: 커밋**

```bash
git add src/pal/
git commit -m "feat(pal): add PathResolver for runtime data paths" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Page 타입 + 직렬화

위키 페이지의 타입(출처·상태 포함)과 `.md` ↔ 객체 직렬화(순수 함수)를 만든다.

**Files:**
- Create: `src/knowledge-core/wiki/page.types.ts`, `src/knowledge-core/wiki/page-serializer.ts`, `src/knowledge-core/wiki/page-serializer.spec.ts`

**Interfaces:**
- Consumes: (없음)
- Produces:
  - `type PageStatus = 'draft' | 'published'`
  - `interface PageFrontmatter { title: string; category: string; status: PageStatus; sources: string[]; created: string; updated: string }`
  - `interface WikiPage { slug: string; frontmatter: PageFrontmatter; body: string }`
  - `interface CreatePageInput { slug: string; title: string; category: string; body: string; sources?: string[]; status?: PageStatus }`
  - `interface UpdatePageInput { title?: string; category?: string; body?: string; sources?: string[] }`
  - `serializePage(page: WikiPage): string`
  - `parsePage(slug: string, fileContent: string): WikiPage`

- [ ] **Step 1: 타입 작성 — `src/knowledge-core/wiki/page.types.ts`**

```ts
// 위키 페이지 모델(설계 §5.1 — 버전관리형 WikiEngine).
// frontmatter에 출처(sources)와 상태(status)를 담아 C 자율쓰기의
// 검증·승인 흐름(§6)의 토대로 삼는다.

export type PageStatus = 'draft' | 'published';

export interface PageFrontmatter {
  title: string;
  category: string;
  status: PageStatus;
  sources: string[]; // 출처 포인터(대화/문서/URL). C 경로에선 비어 있으면 거부 대상.
  created: string; // ISO 8601
  updated: string; // ISO 8601
}

export interface WikiPage {
  slug: string; // 고유 식별자 = 파일명(확장자 제외)
  frontmatter: PageFrontmatter;
  body: string; // 마크다운 본문
}

export interface CreatePageInput {
  slug: string;
  title: string;
  category: string;
  body: string;
  sources?: string[];
  status?: PageStatus; // 기본 'draft'
}

export interface UpdatePageInput {
  title?: string;
  category?: string;
  body?: string;
  sources?: string[];
}
```

- [ ] **Step 2: 실패하는 테스트 작성 — `src/knowledge-core/wiki/page-serializer.spec.ts`**

```ts
import { serializePage, parsePage } from './page-serializer';
import { WikiPage } from './page.types';

describe('page-serializer', () => {
  it('직렬화 후 파싱하면 원본과 같다 (왕복)', () => {
    const page: WikiPage = {
      slug: 'test-page',
      frontmatter: {
        title: '테스트',
        category: 'general',
        status: 'draft',
        sources: ['conv:123'],
        created: '2026-06-21T00:00:00.000Z',
        updated: '2026-06-21T00:00:00.000Z',
      },
      body: '본문 내용입니다.',
    };

    const text = serializePage(page);
    const back = parsePage('test-page', text);

    expect(back).toEqual(page);
  });

  it('frontmatter가 YAML로 직렬화된다', () => {
    const page: WikiPage = {
      slug: 'p',
      frontmatter: {
        title: 'T', category: 'c', status: 'published',
        sources: [], created: '2026-06-21T00:00:00.000Z',
        updated: '2026-06-21T00:00:00.000Z',
      },
      body: 'hi',
    };
    const text = serializePage(page);
    expect(text).toContain('title: T');
    expect(text).toContain('status: published');
  });
});
```

- [ ] **Step 3: 테스트 실행 → 실패 확인**

Run: `npx jest src/knowledge-core/wiki/page-serializer.spec.ts`
Expected: FAIL — `Cannot find module './page-serializer'`.

- [ ] **Step 4: 구현 — `src/knowledge-core/wiki/page-serializer.ts`**

```ts
import matter from 'gray-matter';
import { PageFrontmatter, WikiPage } from './page.types';

// WikiPage <-> .md 파일 문자열 직렬화(설계 §5.1).
// frontmatter(YAML) + 마크다운 본문 구조. gray-matter로 왕복 변환을 보장한다.

export function serializePage(page: WikiPage): string {
  // gray-matter는 (본문, 데이터) 순서로 frontmatter를 앞에 붙여 직렬화한다.
  return matter.stringify(page.body, page.frontmatter);
}

export function parsePage(slug: string, fileContent: string): WikiPage {
  const parsed = matter(fileContent);
  return {
    slug,
    frontmatter: parsed.data as PageFrontmatter,
    // stringify가 본문 앞에 개행을 넣으므로 앞 공백만 제거해 왕복 동일성을 맞춘다.
    body: parsed.content.trimStart(),
  };
}
```

- [ ] **Step 5: 테스트 실행 → 통과 확인**

Run: `npx jest src/knowledge-core/wiki/page-serializer.spec.ts`
Expected: PASS — 2 passed.

- [ ] **Step 6: 커밋**

```bash
git add src/knowledge-core/wiki/page.types.ts src/knowledge-core/wiki/page-serializer.ts src/knowledge-core/wiki/page-serializer.spec.ts
git commit -m "feat(wiki): add page types and serializer" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: WikiEngine CRUD

파일 기반 페이지 CRUD를 구현하고 NestJS 모듈로 묶는다. (git 이력은 Task 6)

**Files:**
- Create: `src/knowledge-core/wiki/wiki-engine.ts`, `src/knowledge-core/wiki/wiki-engine.spec.ts`, `src/knowledge-core/knowledge-core.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `PathResolver`(Task 2), `WikiPage`/`CreatePageInput`/`UpdatePageInput`/`serializePage`/`parsePage`(Task 3)
- Produces: `class WikiEngine`
  - `constructor(paths: PathResolver)`
  - `createPage(input: CreatePageInput): Promise<WikiPage>` — 기본 status `draft`, 이미 존재하면 throw
  - `getPage(slug: string): Promise<WikiPage | null>`
  - `updatePage(slug: string, patch: UpdatePageInput): Promise<WikiPage>` — 없으면 throw, `created` 보존, `updated` 갱신
  - `listPages(): Promise<WikiPage[]>`

- [ ] **Step 1: 실패하는 테스트 작성 — `src/knowledge-core/wiki/wiki-engine.spec.ts`**

```ts
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PathResolver } from '../../pal/path-resolver';
import { WikiEngine } from './wiki-engine';

// 각 테스트는 임시 디렉토리에서 독립 실행한다.
async function makeEngine(): Promise<WikiEngine> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-wiki-'));
  return new WikiEngine(new PathResolver(dir));
}

describe('WikiEngine CRUD', () => {
  it('페이지를 생성하고 다시 읽으면 같은 내용이다', async () => {
    const engine = await makeEngine();
    const created = await engine.createPage({
      slug: 'hello', title: '안녕', category: 'general', body: '첫 글',
    });
    expect(created.frontmatter.status).toBe('draft');

    const read = await engine.getPage('hello');
    expect(read?.body).toBe('첫 글');
    expect(read?.frontmatter.title).toBe('안녕');
  });

  it('없는 페이지는 null을 반환한다', async () => {
    const engine = await makeEngine();
    expect(await engine.getPage('nope')).toBeNull();
  });

  it('중복 slug 생성은 에러를 던진다', async () => {
    const engine = await makeEngine();
    await engine.createPage({ slug: 'dup', title: 'T', category: 'c', body: 'x' });
    await expect(
      engine.createPage({ slug: 'dup', title: 'T2', category: 'c', body: 'y' }),
    ).rejects.toThrow();
  });

  it('업데이트는 본문을 바꾸고 created를 보존한다', async () => {
    const engine = await makeEngine();
    const a = await engine.createPage({ slug: 'p', title: 'T', category: 'c', body: 'old' });
    const b = await engine.updatePage('p', { body: 'new' });
    expect(b.body).toBe('new');
    expect(b.frontmatter.created).toBe(a.frontmatter.created);
  });

  it('listPages는 생성된 모든 페이지를 반환한다', async () => {
    const engine = await makeEngine();
    await engine.createPage({ slug: 'a', title: 'A', category: 'c', body: 'x' });
    await engine.createPage({ slug: 'b', title: 'B', category: 'c', body: 'y' });
    const all = await engine.listPages();
    expect(all.map((p) => p.slug).sort()).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npx jest src/knowledge-core/wiki/wiki-engine.spec.ts`
Expected: FAIL — `Cannot find module './wiki-engine'`.

- [ ] **Step 3: 구현 — `src/knowledge-core/wiki/wiki-engine.ts`**

```ts
import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PathResolver } from '../../pal/path-resolver';
import { serializePage, parsePage } from './page-serializer';
import { WikiPage, CreatePageInput, UpdatePageInput } from './page.types';

// 위키 페이지의 버전관리형 저장소(설계 §5.1).
// .md 파일 CRUD + 출처/상태 메타데이터를 다룬다. (git 이력은 WikiGit가 담당 — Task 6)
@Injectable()
export class WikiEngine {
  constructor(private readonly paths: PathResolver) {}

  private pagePath(slug: string): string {
    return path.join(this.paths.getWikiPagesDir(), `${slug}.md`);
  }

  // 페이지 생성. 기본 상태는 draft(검증·승인 전 초안, §6).
  // 통째 교체 금지 원칙에 따라 이미 존재하면 덮어쓰지 않고 실패시킨다('wx').
  async createPage(input: CreatePageInput): Promise<WikiPage> {
    const now = new Date().toISOString();
    const page: WikiPage = {
      slug: input.slug,
      frontmatter: {
        title: input.title,
        category: input.category,
        status: input.status ?? 'draft',
        sources: input.sources ?? [],
        created: now,
        updated: now,
      },
      body: input.body,
    };
    await fs.mkdir(this.paths.getWikiPagesDir(), { recursive: true });
    await fs.writeFile(this.pagePath(input.slug), serializePage(page), {
      flag: 'wx',
    });
    return page;
  }

  // 페이지 읽기. 없으면 null.
  async getPage(slug: string): Promise<WikiPage | null> {
    try {
      const content = await fs.readFile(this.pagePath(slug), 'utf8');
      return parsePage(slug, content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  // 페이지 수정. created는 보존하고 updated만 갱신한다.
  async updatePage(slug: string, patch: UpdatePageInput): Promise<WikiPage> {
    const existing = await this.getPage(slug);
    if (!existing) throw new Error(`Page not found: ${slug}`);
    const updated: WikiPage = {
      slug,
      frontmatter: {
        ...existing.frontmatter,
        title: patch.title ?? existing.frontmatter.title,
        category: patch.category ?? existing.frontmatter.category,
        sources: patch.sources ?? existing.frontmatter.sources,
        updated: new Date().toISOString(),
      },
      body: patch.body ?? existing.body,
    };
    await fs.writeFile(this.pagePath(slug), serializePage(updated));
    return updated;
  }

  // 전체 페이지 목록.
  async listPages(): Promise<WikiPage[]> {
    const dir = this.paths.getWikiPagesDir();
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const pages: WikiPage[] = [];
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const page = await this.getPage(f.slice(0, -3));
      if (page) pages.push(page);
    }
    return pages;
  }
}
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `npx jest src/knowledge-core/wiki/wiki-engine.spec.ts`
Expected: PASS — 5 passed.

- [ ] **Step 5: NestJS 모듈 작성 — `src/knowledge-core/knowledge-core.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { PathResolver } from '../pal/path-resolver';
import { WikiEngine } from './wiki/wiki-engine';

// KnowledgeCore: 단일 진실원(설계 §5). Phase 0에선 WikiEngine부터.
// PathResolver는 string 인자를 DI로 주입할 수 없으므로 useFactory로 기본값 생성.
@Module({
  providers: [
    { provide: PathResolver, useFactory: () => new PathResolver() },
    WikiEngine,
  ],
  exports: [WikiEngine],
})
export class KnowledgeCoreModule {}
```

- [ ] **Step 6: `src/app.module.ts` 수정 — 모듈 import**

```ts
import { Module } from '@nestjs/common';
import { KnowledgeCoreModule } from './knowledge-core/knowledge-core.module';

// Engram 루트 모듈.
@Module({
  imports: [KnowledgeCoreModule],
})
export class AppModule {}
```

- [ ] **Step 7: 전체 테스트 실행 → 통과 확인 (모듈 와이어링 회귀 확인)**

Run: `npm test`
Expected: PASS — `app.module`, `path-resolver`, `page-serializer`, `wiki-engine` 모두 통과.

- [ ] **Step 8: 커밋**

```bash
git add src/knowledge-core/ src/app.module.ts
git commit -m "feat(wiki): add WikiEngine CRUD and KnowledgeCore module" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: draft/published 상태

승인 게이트(§6)의 반영 지점인 `publishPage`와 status 필터를 추가한다.

**Files:**
- Modify: `src/knowledge-core/wiki/wiki-engine.ts`
- Modify: `src/knowledge-core/wiki/wiki-engine.spec.ts`

**Interfaces:**
- Consumes: Task 4 `WikiEngine`, `PageStatus`(Task 3)
- Produces (WikiEngine에 추가):
  - `publishPage(slug: string): Promise<WikiPage>` — status를 `published`로, `updated` 갱신
  - `listPages(filter?: { status?: PageStatus }): Promise<WikiPage[]>` — status로 필터(Task 4 시그니처 확장)

- [ ] **Step 1: 실패하는 테스트 추가 — `src/knowledge-core/wiki/wiki-engine.spec.ts` 끝에 append**

```ts
describe('WikiEngine 상태(draft/published)', () => {
  it('publishPage는 상태를 published로 바꾼다', async () => {
    const engine = await makeEngine();
    await engine.createPage({ slug: 'p', title: 'T', category: 'c', body: 'x' });
    const pub = await engine.publishPage('p');
    expect(pub.frontmatter.status).toBe('published');

    const read = await engine.getPage('p');
    expect(read?.frontmatter.status).toBe('published');
  });

  it('publishPage는 없는 페이지에 에러를 던진다', async () => {
    const engine = await makeEngine();
    await expect(engine.publishPage('nope')).rejects.toThrow();
  });

  it('listPages({status}) 는 상태로 필터링한다', async () => {
    const engine = await makeEngine();
    await engine.createPage({ slug: 'd', title: 'D', category: 'c', body: 'x' }); // draft
    await engine.createPage({ slug: 'p', title: 'P', category: 'c', body: 'y' });
    await engine.publishPage('p');

    const published = await engine.listPages({ status: 'published' });
    expect(published.map((x) => x.slug)).toEqual(['p']);

    const all = await engine.listPages();
    expect(all.length).toBe(2);
  });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npx jest src/knowledge-core/wiki/wiki-engine.spec.ts`
Expected: FAIL — `engine.publishPage is not a function` (및 필터 인자 미지원).

- [ ] **Step 3: 구현 — `wiki-engine.ts`의 `listPages` 교체 + `publishPage` 추가**

`listPages`를 아래로 교체(필터 인자 추가):

```ts
  // 페이지 목록. status로 선택 필터링.
  async listPages(filter?: {
    status?: import('./page.types').PageStatus;
  }): Promise<WikiPage[]> {
    const dir = this.paths.getWikiPagesDir();
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const pages: WikiPage[] = [];
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const page = await this.getPage(f.slice(0, -3));
      if (!page) continue;
      if (filter?.status && page.frontmatter.status !== filter.status) continue;
      pages.push(page);
    }
    return pages;
  }

  // draft → published 전환(승인 게이트 통과 시, §6 반영 지점).
  async publishPage(slug: string): Promise<WikiPage> {
    const existing = await this.getPage(slug);
    if (!existing) throw new Error(`Page not found: ${slug}`);
    const published: WikiPage = {
      ...existing,
      frontmatter: {
        ...existing.frontmatter,
        status: 'published',
        updated: new Date().toISOString(),
      },
    };
    await fs.writeFile(this.pagePath(slug), serializePage(published));
    return published;
  }
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `npx jest src/knowledge-core/wiki/wiki-engine.spec.ts`
Expected: PASS — 8 passed (Task 4의 5 + 신규 3).

- [ ] **Step 5: 커밋**

```bash
git add src/knowledge-core/wiki/wiki-engine.ts src/knowledge-core/wiki/wiki-engine.spec.ts
git commit -m "feat(wiki): add draft/published status and publishPage" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: git 이력 (WikiGit)

위키 데이터 디렉토리를 git 저장소로 만들어 모든 변경을 커밋으로 남긴다(감사·되돌리기).

**Files:**
- Create: `src/knowledge-core/wiki/wiki-git.ts`, `src/knowledge-core/wiki/wiki-git.spec.ts`
- Modify: `src/knowledge-core/wiki/wiki-engine.ts` (WikiGit 주입 + 쓰기 후 커밋)
- Modify: `src/knowledge-core/knowledge-core.module.ts` (WikiGit provider 추가)

**Interfaces:**
- Consumes: `PathResolver`(Task 2), `WikiEngine`(Task 4·5)
- Produces:
  - `class WikiGit`
    - `constructor(paths: PathResolver)`
    - `ensureRepo(): Promise<void>` — 디렉토리 생성 + (필요 시) `git init` + 데이터 전용 커밋 신원 설정
    - `commitAll(message: string): Promise<void>` — 전체 스테이징 후 커밋(변경 없으면 no-op)
    - `recentMessages(limit?: number): Promise<string[]>` — 최근 커밋 메시지(테스트·감사용)
  - `WikiEngine` 생성자 변경: `constructor(paths: PathResolver, git: WikiGit)`; create/update/publish가 각각 commitAll 호출

- [ ] **Step 1: 실패하는 테스트 작성 — `src/knowledge-core/wiki/wiki-git.spec.ts`**

```ts
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PathResolver } from '../../pal/path-resolver';
import { WikiEngine } from './wiki-engine';
import { WikiGit } from './wiki-git';

async function setup(): Promise<{ engine: WikiEngine; git: WikiGit }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-git-'));
  const paths = new PathResolver(dir);
  const git = new WikiGit(paths);
  await git.ensureRepo();
  const engine = new WikiEngine(paths, git);
  return { engine, git };
}

describe('WikiGit 이력', () => {
  it('페이지 생성이 git 커밋으로 남는다', async () => {
    const { engine, git } = await setup();
    await engine.createPage({
      slug: 'hello', title: '안녕', category: 'c', body: 'x', sources: ['conv:1'],
    });
    const msgs = await git.recentMessages();
    expect(msgs[0]).toContain('hello');
  });

  it('생성과 수정이 각각 별도 커밋이 된다', async () => {
    const { engine, git } = await setup();
    await engine.createPage({ slug: 'p', title: 'T', category: 'c', body: 'old' });
    await engine.updatePage('p', { body: 'new' });
    const msgs = await git.recentMessages();
    expect(msgs.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npx jest src/knowledge-core/wiki/wiki-git.spec.ts`
Expected: FAIL — `Cannot find module './wiki-git'`.

- [ ] **Step 3: 구현 — `src/knowledge-core/wiki/wiki-git.ts`**

```ts
import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import simpleGit, { SimpleGit } from 'simple-git';
import { PathResolver } from '../../pal/path-resolver';

// 위키 데이터 디렉토리의 git 이력 관리(설계 §5.1).
// 모든 변경을 커밋으로 남겨 감사·되돌리기를 가능케 한다.
// 코드 repo와 분리된, 데이터 전용 git 저장소다(runtime/wiki).
@Injectable()
export class WikiGit {
  private readonly git: SimpleGit;

  constructor(private readonly paths: PathResolver) {
    this.git = simpleGit();
  }

  // 위키 디렉토리를 git 저장소로 보장(이미 init돼 있으면 신원만 확인).
  async ensureRepo(): Promise<void> {
    const dir = this.paths.getWikiDir();
    await fs.mkdir(dir, { recursive: true });
    this.git.cwd(dir);
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      await this.git.init();
    }
    // 데이터 저장소 전용 커밋 신원(코드 repo의 사용자와 분리).
    await this.git.addConfig('user.name', 'Engram');
    await this.git.addConfig('user.email', 'engram@localhost');
  }

  // 위키 디렉토리의 모든 변경을 커밋. 변경이 없으면 빈 커밋을 만들지 않는다.
  async commitAll(message: string): Promise<void> {
    this.git.cwd(this.paths.getWikiDir());
    await this.git.add('.');
    const status = await this.git.status();
    if (status.files.length === 0) return;
    await this.git.commit(message);
  }

  // 최근 커밋 메시지(최신순). 테스트·감사용.
  async recentMessages(limit = 10): Promise<string[]> {
    this.git.cwd(this.paths.getWikiDir());
    const log = await this.git.log({ maxCount: limit });
    return log.all.map((c) => c.message);
  }
}
```

- [ ] **Step 4: `wiki-engine.ts` 수정 — WikiGit 주입 + 쓰기 후 커밋**

생성자와 세 메서드(create/update/publish)를 아래로 교체:

```ts
  constructor(
    private readonly paths: PathResolver,
    private readonly git: WikiGit,
  ) {}
```

create/update/publish의 `return` 직전에 커밋 호출을 추가한다. 각 메서드 전체는 다음과 같다:

```ts
  async createPage(input: CreatePageInput): Promise<WikiPage> {
    const now = new Date().toISOString();
    const page: WikiPage = {
      slug: input.slug,
      frontmatter: {
        title: input.title,
        category: input.category,
        status: input.status ?? 'draft',
        sources: input.sources ?? [],
        created: now,
        updated: now,
      },
      body: input.body,
    };
    await fs.mkdir(this.paths.getWikiPagesDir(), { recursive: true });
    await fs.writeFile(this.pagePath(input.slug), serializePage(page), {
      flag: 'wx',
    });
    await this.git.commitAll(`create ${input.slug}`);
    return page;
  }

  async updatePage(slug: string, patch: UpdatePageInput): Promise<WikiPage> {
    const existing = await this.getPage(slug);
    if (!existing) throw new Error(`Page not found: ${slug}`);
    const updated: WikiPage = {
      slug,
      frontmatter: {
        ...existing.frontmatter,
        title: patch.title ?? existing.frontmatter.title,
        category: patch.category ?? existing.frontmatter.category,
        sources: patch.sources ?? existing.frontmatter.sources,
        updated: new Date().toISOString(),
      },
      body: patch.body ?? existing.body,
    };
    await fs.writeFile(this.pagePath(slug), serializePage(updated));
    await this.git.commitAll(`update ${slug}`);
    return updated;
  }

  async publishPage(slug: string): Promise<WikiPage> {
    const existing = await this.getPage(slug);
    if (!existing) throw new Error(`Page not found: ${slug}`);
    const published: WikiPage = {
      ...existing,
      frontmatter: {
        ...existing.frontmatter,
        status: 'published',
        updated: new Date().toISOString(),
      },
    };
    await fs.writeFile(this.pagePath(slug), serializePage(published));
    await this.git.commitAll(`publish ${slug}`);
    return published;
  }
```

그리고 import에 `WikiGit`를 추가한다:

```ts
import { WikiGit } from './wiki-git';
```

- [ ] **Step 5: `wiki-engine.spec.ts` 의 `makeEngine` 헬퍼 수정 (WikiGit 주입)**

기존 `makeEngine`를 아래로 교체(WikiGit를 함께 구성):

```ts
import { WikiGit } from './wiki-git';

async function makeEngine(): Promise<WikiEngine> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-wiki-'));
  const paths = new PathResolver(dir);
  const git = new WikiGit(paths);
  await git.ensureRepo();
  return new WikiEngine(paths, git);
}
```

- [ ] **Step 6: `knowledge-core.module.ts` 수정 — WikiGit provider + 시작 시 ensureRepo**

```ts
import { Module, OnModuleInit } from '@nestjs/common';
import { PathResolver } from '../pal/path-resolver';
import { WikiEngine } from './wiki/wiki-engine';
import { WikiGit } from './wiki/wiki-git';

// KnowledgeCore: 단일 진실원(설계 §5). 시작 시 위키 git 저장소를 보장한다.
@Module({
  providers: [
    { provide: PathResolver, useFactory: () => new PathResolver() },
    WikiGit,
    WikiEngine,
  ],
  exports: [WikiEngine],
})
export class KnowledgeCoreModule implements OnModuleInit {
  constructor(private readonly git: WikiGit) {}

  async onModuleInit(): Promise<void> {
    await this.git.ensureRepo();
  }
}
```

- [ ] **Step 7: 전체 테스트 실행 → 통과 확인**

Run: `npm test`
Expected: PASS — 모든 스펙 통과(`wiki-git` 2 + 기존 전부). WikiEngine 스펙이 WikiGit 주입 헬퍼로도 통과.

- [ ] **Step 8: 빌드 확인**

Run: `npm run build`
Expected: 타입 에러 없이 `dist/` 생성.

- [ ] **Step 9: 커밋**

```bash
git add src/knowledge-core/
git commit -m "feat(wiki): back WikiEngine writes with git history" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (이 계획의 범위 = 설계 §5.1 WikiEngine + 스캐폴딩):**
- 버전관리형 WikiEngine(.md + frontmatter) → Task 3·4 ✓
- 출처(sources) frontmatter → Task 3 ✓
- draft/published 상태 → Task 5 ✓
- git 이력 → Task 6 ✓
- 코드/데이터 분리(`runtime/`, PathResolver) → Task 2 ✓
- NestJS 골격 → Task 1·4 ✓
- (범위 밖, 다음 계획) RagStore/LanceDB·임베딩·하이브리드 검색, 수집 1경로, 상주 위생(lru-cache·pino), 증분 색인·파일 워처 → **Phase 0 Part 2·3에서**

**2. Placeholder scan:** "TODO/적절히 처리" 등 없음. 모든 step에 실제 코드·명령·기대 출력 포함. ✓

**3. Type consistency:** `WikiPage`/`PageFrontmatter`/`PageStatus`/`CreatePageInput`/`UpdatePageInput`는 Task 3 정의를 Task 4·5·6에서 동일 사용. `listPages` 시그니처는 Task 5에서 `filter?: { status? }`로 확장(호출부 없음→안전). `WikiEngine` 생성자는 Task 6에서 `(paths, git)`로 변경되며 모듈(Task 6 Step 6)과 테스트 헬퍼(Task 6 Step 5)를 함께 갱신 → 일관. ✓

---

## 다음 계획 (예고)

- **Phase 0 Part 2 — RagStore**: LanceDB + 로컬 임베딩(`IEmbedder`, 다국어) + 하이브리드(BM25+벡터) + 증분 색인. *(LanceDB Node API는 작성 시 context7로 현행 확인)*
- **Phase 0 Part 3 — 수집 1경로 + 상주 위생**: 위키↔RAG 재색인 묶기, lru-cache·pino 로깅, 파일 워처.
