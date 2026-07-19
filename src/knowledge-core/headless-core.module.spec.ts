import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Test } from '@nestjs/testing';
import { HeadlessCoreModule } from './headless-core.module';
import { WikiEngine } from './wiki/wiki-engine';
import { ProposalStore } from './proposal-store';
import { RagStore } from './rag/rag-store';
import { PathResolver } from '../pal/path-resolver';

// 근본픽스(2026-07-20): 헤드리스 MCP 코어 모드는 RagStore를 절대 구성/초기화하지 않는다
// (%APPDATA%\Engram\rag LanceDB 폴더는 앱 전용 — 크로스 프로세스 손상 3건의 근본 원인 제거).
describe('HeadlessCoreModule (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-headless-core-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('RagStore는 모듈 그래프에 없다 — DI 조회 자체가 실패한다(provider 미등록의 직접 증거)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HeadlessCoreModule] })
      .overrideProvider(PathResolver).useValue(new PathResolver(dir))
      .compile();
    await moduleRef.init();

    expect(() => moduleRef.get(RagStore, { strict: false })).toThrow();

    await moduleRef.close();
  });

  it('init 후에도 rag 디렉터리가 생기지 않는다(LanceDB가 물리적으로 한 번도 열리지 않았다는 증거)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HeadlessCoreModule] })
      .overrideProvider(PathResolver).useValue(new PathResolver(dir))
      .compile();
    await moduleRef.init();

    const ragDirExists = await fs.stat(path.join(dir, 'rag')).then(() => true).catch(() => false);
    expect(ragDirExists).toBe(false);

    await moduleRef.close();
  });

  it('wiki 파일 CRUD는 정상 동작(파일 기반 경로는 그대로 안전)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HeadlessCoreModule] })
      .overrideProvider(PathResolver).useValue(new PathResolver(dir))
      .compile();
    await moduleRef.init();

    const wiki = moduleRef.get(WikiEngine);
    await wiki.createPage({ slug: 'hc', title: 'HC', category: 'c', body: '헤드리스 코어 본문', status: 'published' });
    const page = await wiki.getPage('hc');
    expect(page?.body).toBe('헤드리스 코어 본문');

    await moduleRef.close();
  });

  it('indexer 미탑재 — wiki.search()는 색인 없이 빈 배열(호출자가 텍스트 폴백으로 대체할 신호)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HeadlessCoreModule] })
      .overrideProvider(PathResolver).useValue(new PathResolver(dir))
      .compile();
    await moduleRef.init();

    const wiki = moduleRef.get(WikiEngine);
    await wiki.createPage({ slug: 'hc2', title: 'HC2', category: 'c', body: '검색될 리가 없는 본문', status: 'published' });
    expect(await wiki.search('검색')).toEqual([]);

    await moduleRef.close();
  });

  it('ProposalStore도 함께 배선되어 있다(제안 큐는 파일 기반 — 안전)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HeadlessCoreModule] })
      .overrideProvider(PathResolver).useValue(new PathResolver(dir))
      .compile();
    await moduleRef.init();

    const proposals = moduleRef.get(ProposalStore);
    const p = await proposals.enqueue({
      userId: 'default', op: 'create', targetSlug: 'x', title: 'X', category: 'c',
      payload: 'p', sources: [], importance: 1, verdict: { confidence: 0.5, reason: 'test' },
    });
    expect(p.status).toBe('pending');

    await moduleRef.close();
  });
});
