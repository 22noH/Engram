import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExtractOutcome } from './extractors';
import { FolderImporter, ImporterPorts, ScannedFile, SubmitPage } from './folder-importer';
import { ImportLedger, MAX_ATTEMPTS } from './import-ledger';
import { DEFAULT_IMPORT_CONFIG, FolderImportConfig } from './import.config';

// 가짜 포트로 실행부 전체를 검증한다 — 파일시스템·두뇌·위키는 전부 주입이라 여기 테스트는 순수하다.

interface Harness {
  importer: FolderImporter;
  ledger: ImportLedger;
  ports: ImporterPorts;
  proposed: SubmitPage[];
  published: SubmitPage[];
  organizeCalls: string[];
  dir: string;
}

function file(rel: string, over: Partial<ScannedFile> = {}): ScannedFile {
  return { rel, absPath: `/w/${rel}`, name: rel.split('/').pop()!, size: 100, mtimeMs: 1000, ...over };
}

function cfg(over: Partial<FolderImportConfig> = {}): FolderImportConfig {
  return { ...DEFAULT_IMPORT_CONFIG, enabled: true, folder: '/w', ...over };
}

function harness(over: Partial<ImporterPorts> = {}, files: ScannedFile[] = [file('a.md')]): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-import-'));
  const ledger = new ImportLedger(path.join(dir, 'ledger.json'));
  const proposed: SubmitPage[] = [];
  const published: SubmitPage[] = [];
  const organizeCalls: string[] = [];
  let n = 0;
  const ports: ImporterPorts = {
    listFiles: async () => files,
    hashFile: async (p) => `hash-${p}`,
    extract: async (): Promise<ExtractOutcome> => ({ ok: true, doc: { text: '파일 내용' } }),
    organize: async (prompt) => {
      organizeCalls.push(prompt);
      return { text: '{"pages":[{"title":"정리된 제목","category":"note","body":"정리된 본문"}]}' };
    },
    findRelated: async () => [],
    pageExists: async () => false,
    propose: async (p) => { proposed.push(p); return `prop-${++n}`; },
    publishNow: async (p) => { published.push(p); },
    now: () => new Date('2026-07-25T00:00:00.000Z'),
    log: () => undefined,
    ...over,
  };
  return { importer: new FolderImporter(ports, ledger), ledger, ports, proposed, published, organizeCalls, dir };
}

function cleanup(h: Harness): void {
  fs.rmSync(h.dir, { recursive: true, force: true });
}

describe('FolderImporter — 기본 흐름', () => {
  it('꺼져 있거나 폴더가 비면 아무것도 안 한다', async () => {
    const h = harness();
    expect(await h.importer.runOnce(cfg({ enabled: false }))).toMatchObject({ scanned: 0, processed: 0 });
    expect(await h.importer.runOnce(cfg({ folder: '' }))).toMatchObject({ scanned: 0 });
    expect(h.proposed).toHaveLength(0);
    cleanup(h);
  });

  it('기본은 승인함으로 보낸다(바로 게시 아님)', async () => {
    const h = harness();
    const r = await h.importer.runOnce(cfg());
    expect(r).toMatchObject({ scanned: 1, processed: 1, failed: 0, skipped: 0 });
    expect(h.published).toHaveLength(0);
    expect(h.proposed).toHaveLength(1);
    expect(h.proposed[0]).toMatchObject({ op: 'create', title: '정리된 제목', category: 'note' });
    cleanup(h);
  });

  it('설정이 바로 게시면 승인함을 건너뛴다', async () => {
    const h = harness();
    await h.importer.runOnce(cfg({ publish: 'direct' }));
    expect(h.proposed).toHaveLength(0);
    expect(h.published).toHaveLength(1);
    cleanup(h);
  });

  it('출처를 본문과 sources 양쪽에 남긴다', async () => {
    const h = harness({}, [file('notes/회의록.md')]);
    await h.importer.runOnce(cfg());
    expect(h.proposed[0].body).toContain('notes/회의록.md');
    expect(h.proposed[0].sources).toEqual(['file:notes/회의록.md']);
    cleanup(h);
  });

  it('원문 그대로 모드는 두뇌를 부르지 않는다', async () => {
    const h = harness();
    await h.importer.runOnce(cfg({ mode: 'raw' }));
    expect(h.organizeCalls).toHaveLength(0);
    expect(h.proposed[0].body).toContain('파일 내용');
    cleanup(h);
  });

  it('원본을 건드리는 포트는 아예 존재하지 않는다(이동·이름변경·삭제 없음)', () => {
    const h = harness();
    expect(Object.keys(h.ports).sort()).toEqual(
      ['extract', 'findRelated', 'hashFile', 'listFiles', 'log', 'now', 'organize', 'pageExists', 'propose', 'publishNow'],
    );
    cleanup(h);
  });
});

describe('FolderImporter — 긴 문서 분할과 기존 문서 덧붙이기', () => {
  it('두뇌가 나눈 여러 페이지를 각각 제안한다', async () => {
    const h = harness({
      organize: async () => ({ text: '{"pages":[{"title":"주제 A","body":"1"},{"title":"주제 B","body":"2"}]}' }),
    });
    const r = await h.importer.runOnce(cfg());
    expect(r.pages).toHaveLength(2);
    expect(h.proposed.map((p) => p.title)).toEqual(['주제 A', '주제 B']);
    cleanup(h);
  });

  it('이미 있는 문서면 새 페이지 대신 그 slug로 덧붙인다', async () => {
    const h = harness({
      findRelated: async () => [{ slug: 'deploy-guide', title: '배포 가이드' }],
      organize: async () => ({ text: '{"pages":[{"slug":"deploy-guide","title":"배포 가이드","body":"추가 내용"}]}' }),
    });
    await h.importer.runOnce(cfg());
    expect(h.proposed[0]).toMatchObject({ slug: 'deploy-guide', op: 'append' });
    cleanup(h);
  });

  it('두뇌가 지어낸 slug라도 실제로 있으면 덧붙이기로 인정한다', async () => {
    const h = harness({
      findRelated: async () => [],
      pageExists: async (s) => s === 'real-page',
      organize: async () => ({ text: '{"pages":[{"slug":"real-page","title":"T","body":"B"}]}' }),
    });
    await h.importer.runOnce(cfg());
    expect(h.proposed[0]).toMatchObject({ slug: 'real-page', op: 'append' });
    cleanup(h);
  });

  it('없는 slug면 신규로 강등한다(빈 페이지 방지)', async () => {
    const h = harness({
      organize: async () => ({ text: '{"pages":[{"slug":"ghost","title":"새 제목","body":"B"}]}' }),
    });
    await h.importer.runOnce(cfg());
    expect(h.proposed[0]).toMatchObject({ slug: '새-제목', op: 'create' });
    cleanup(h);
  });

  it('한 파일이 만들 수 있는 페이지 수에 천장이 있다', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `T${i}`, body: 'b' }));
    const h = harness({ organize: async () => ({ text: JSON.stringify({ pages: many }) }) });
    const r = await h.importer.runOnce(cfg());
    expect(r.pages).toHaveLength(10);
    cleanup(h);
  });
});

describe('FolderImporter — 재처리 방지', () => {
  it('같은 파일을 두 번 스캔해도 두 번 변환하지 않는다(앱 재시작 시나리오)', async () => {
    const h = harness();
    await h.importer.runOnce(cfg());
    const second = await h.importer.runOnce(cfg());
    expect(second.processed).toBe(0);
    expect(h.proposed).toHaveLength(1);
    cleanup(h);
  });

  it('파일이 실제로 바뀌면 다시 변환한다', async () => {
    const files = [file('a.md')];
    let hash = 'h1';
    const h = harness({ listFiles: async () => files, hashFile: async () => hash }, files);
    await h.importer.runOnce(cfg());
    files[0] = file('a.md', { size: 200, mtimeMs: 2000 });
    hash = 'h2';
    const second = await h.importer.runOnce(cfg());
    expect(second.processed).toBe(1);
    expect(h.proposed).toHaveLength(2);
    cleanup(h);
  });

  it('내용이 그대로면 mtime만 바뀌어도 두뇌를 다시 부르지 않는다', async () => {
    const files = [file('a.md')];
    const h = harness({ listFiles: async () => files, hashFile: async () => 'same' }, files);
    await h.importer.runOnce(cfg());
    files[0] = file('a.md', { mtimeMs: 99999 }); // touch만
    const second = await h.importer.runOnce(cfg());
    expect(second.processed).toBe(0);
    expect(h.organizeCalls).toHaveLength(1);
    cleanup(h);
  });

  it('크기·시각이 같으면 해시조차 계산하지 않는다', async () => {
    const hashed: string[] = [];
    const h = harness({ hashFile: async (p) => { hashed.push(p); return 'h'; } });
    await h.importer.runOnce(cfg());
    const before = hashed.length;
    await h.importer.runOnce(cfg());
    expect(hashed.length).toBe(before);
    cleanup(h);
  });
});

describe('FolderImporter — 미지원 형식은 이유와 함께 남긴다', () => {
  it('건너뛴 파일이 상태에 이유와 함께 기록된다', async () => {
    const h = harness({ extract: async () => ({ skip: true, reason: 'unsupported' }) });
    const r = await h.importer.runOnce(cfg());
    expect(r).toMatchObject({ skipped: 1, processed: 0 });
    expect(h.ledger.get('a.md')).toMatchObject({ status: 'skipped', reason: 'unsupported' });
    cleanup(h);
  });

  it('크기 상한을 넘는 파일은 읽지도 않고 이유를 남긴다', async () => {
    const extracted: string[] = [];
    const h = harness({ extract: async (f) => { extracted.push(f.rel); return { ok: true, doc: { text: 'x' } }; } },
      [file('big.pdf', { size: 999_999_999 })]);
    const r = await h.importer.runOnce(cfg());
    expect(r.skipped).toBe(1);
    expect(extracted).toEqual([]);
    expect(h.ledger.get('big.pdf')).toMatchObject({ status: 'skipped', reason: 'tooLarge' });
    cleanup(h);
  });

  it('건너뛴 파일은 다음 스캔에서 다시 시도하지 않는다', async () => {
    let calls = 0;
    const h = harness({ extract: async () => { calls++; return { skip: true, reason: 'unsupported' }; } });
    await h.importer.runOnce(cfg());
    await h.importer.runOnce(cfg());
    expect(calls).toBe(1);
    cleanup(h);
  });
});

describe('FolderImporter — 실패 격리(never-throw)', () => {
  it('한 파일의 실패가 나머지 파일 처리를 막지 않는다', async () => {
    const files = [file('bad.md'), file('good.md')];
    const h = harness({
      extract: async (f) => {
        if (f.rel === 'bad.md') throw new Error('boom');
        return { ok: true, doc: { text: 'ok' } };
      },
    }, files);
    const r = await h.importer.runOnce(cfg());
    expect(r).toMatchObject({ failed: 1, processed: 1 });
    expect(h.ledger.get('bad.md')).toMatchObject({ status: 'failed' });
    expect(h.proposed).toHaveLength(1);
    cleanup(h);
  });

  it('두뇌 실패는 이유와 함께 기록된다', async () => {
    const h = harness({ organize: async () => ({ error: '한도 초과' }) });
    const r = await h.importer.runOnce(cfg());
    expect(r.failed).toBe(1);
    expect(h.ledger.get('a.md')?.reason).toContain('한도 초과');
    cleanup(h);
  });

  it('두뇌 응답이 형태가 아니면 실패로 기록한다(빈 페이지 생성 금지)', async () => {
    const h = harness({ organize: async () => ({ text: '음... 잘 모르겠어요' }) });
    const r = await h.importer.runOnce(cfg());
    expect(r.failed).toBe(1);
    expect(h.proposed).toHaveLength(0);
    expect(h.ledger.get('a.md')?.reason).toBe('organizeParse');
    cleanup(h);
  });

  it('실패는 상한까지만 재시도한다', async () => {
    let calls = 0;
    const h = harness({ organize: async () => { calls++; return { error: 'x' }; } });
    for (let i = 0; i < 6; i++) await h.importer.runOnce(cfg());
    expect(calls).toBe(MAX_ATTEMPTS);
    cleanup(h);
  });

  it('목록 조회 자체가 터져도 runOnce는 throw하지 않는다', async () => {
    const h = harness({ listFiles: async () => { throw new Error('EPERM'); } });
    await expect(h.importer.runOnce(cfg())).resolves.toMatchObject({ processed: 0 });
    cleanup(h);
  });

  it('관련 문서 검색 실패는 변환을 막지 않는다', async () => {
    const h = harness({ findRelated: async () => { throw new Error('rag down'); } });
    const r = await h.importer.runOnce(cfg());
    expect(r.processed).toBe(1);
    cleanup(h);
  });
});

describe('FolderImporter — 비용 상한', () => {
  it('한 번에 처리할 파일 수를 넘기면 나머지는 대기로 남긴다', async () => {
    const files = ['a.md', 'b.md', 'c.md', 'd.md'].map((r) => file(r));
    const h = harness({}, files);
    const r = await h.importer.runOnce(cfg({ maxFilesPerRun: 2 }));
    expect(r).toMatchObject({ processed: 2, pending: 2 });
    expect(h.proposed).toHaveLength(2);
    expect(h.ledger.get('c.md')).toMatchObject({ status: 'pending' });
    cleanup(h);
  });

  it('대기분은 다음 스캔이 이어받는다', async () => {
    const files = ['a.md', 'b.md', 'c.md'].map((r) => file(r));
    const h = harness({}, files);
    await h.importer.runOnce(cfg({ maxFilesPerRun: 2 }));
    const second = await h.importer.runOnce(cfg({ maxFilesPerRun: 2 }));
    expect(second.processed).toBe(1);
    expect(h.proposed).toHaveLength(3);
    cleanup(h);
  });

  it('스캔이 겹쳐 돌지 않는다(같은 파일 이중 변환 방지)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => { release = res; });
    const h = harness({ extract: async () => { await gate; return { ok: true, doc: { text: 'x' } }; } });
    const first = h.importer.runOnce(cfg());
    const second = await h.importer.runOnce(cfg()); // 아직 첫 스캔이 도는 중
    expect(second.processed).toBe(0);
    release();
    expect((await first).processed).toBe(1);
    expect(h.proposed).toHaveLength(1);
    cleanup(h);
  });
});
