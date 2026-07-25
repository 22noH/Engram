import { ExtractOutcome, ExtractedImage } from './extractors';
import { FolderImportConfig } from './import.config';
import { ImportLedger, ImportRecord, MAX_ATTEMPTS, needsProcessing, unchangedByStat } from './import-ledger';
import {
  ExistingPage, OrganizedPage, buildOrganizePrompt, parseOrganized, rawPages, resolveSlug,
  sourceFooter, sourceToken, titleFromRel,
} from './organizer';

// 폴더 → 위키 변환의 실행부. 파일시스템·두뇌·위키는 전부 주입된 포트라 이 파일 자체는
// 가짜 포트만으로 완전히 테스트된다. 규약 두 가지가 이 클래스의 존재 이유다:
//   1) never-throw — 파일 하나가 실패해도 스캔 전체가 죽지 않는다(상태에 기록하고 다음 파일).
//   2) 상한 — 한 번에 처리할 파일 수·크기·본문 길이에 천장을 둬 비용 폭주를 막는다(초과분은 대기).

export interface ScannedFile {
  /** 감시 폴더 기준 상대경로(이력 키). */
  rel: string;
  absPath: string;
  name: string;
  size: number;
  mtimeMs: number;
}

export interface SubmitPage {
  slug: string;
  op: 'create' | 'append';
  title: string;
  category: string;
  body: string;
  sources: string[];
}

export interface ImporterPorts {
  /** 폴더 재귀 스캔. 실패하면 빈 배열(never-throw는 구현 쪽 책임). */
  listFiles(folder: string): Promise<ScannedFile[]>;
  hashFile(absPath: string): Promise<string>;
  extract(file: ScannedFile, cfg: FolderImportConfig): Promise<ExtractOutcome>;
  /** 두뇌 호출. images가 있으면 vision 경로(스캔·사진). */
  organize(prompt: string, images?: ExtractedImage[]): Promise<{ text: string } | { error: string }>;
  /** 관련 기존 문서 검색(RAG) — 중복 페이지 대신 덧붙이기를 고르는 근거. */
  findRelated(query: string): Promise<ExistingPage[]>;
  /** 그 slug의 페이지가 실제로 있는가(두뇌가 지어낸 slug 검증). */
  pageExists(slug: string): Promise<boolean>;
  /** 승인함으로 보내기 → 제안 id. */
  propose(p: SubmitPage): Promise<string>;
  /** 바로 게시(설정에서 명시적으로 고른 경우에만). */
  publishNow(p: SubmitPage): Promise<void>;
  now(): Date;
  log(level: 'log' | 'warn' | 'error', msg: string): void;
}

export interface ImportRunResult {
  scanned: number;
  processed: number;
  skipped: number;
  failed: number;
  pending: number;
  pages: string[];
}

/** 파일 하나가 만들 수 있는 최대 페이지 수 — 두뇌가 폭주해도 위키가 잠기지 않게. */
export const MAX_PAGES_PER_FILE = 10;
/** 관련 문서 검색에 쓰는 질의 길이(본문 앞부분). */
const RELATED_QUERY_CHARS = 400;
/** 크기 상한 초과 사유 코드. */
export const REASON_TOO_LARGE = 'tooLarge';
export const REASON_ORGANIZE_FAILED = 'organizeFailed';
export const REASON_ORGANIZE_PARSE = 'organizeParse';

export class FolderImporter {
  /** 동시 실행 방지 — 워처 이벤트와 "지금 검사"가 겹쳐도 스캔은 한 번에 하나. */
  private running = false;

  constructor(private readonly ports: ImporterPorts, private readonly ledger: ImportLedger) {}

  isRunning(): boolean {
    return this.running;
  }

  /**
   * 폴더를 한 번 훑어 처리한다. 절대 throw하지 않는다.
   * 상한(maxFilesPerRun)에 걸린 나머지는 'pending'으로 남겨 다음 스캔이 이어받는다.
   */
  async runOnce(cfg: FolderImportConfig): Promise<ImportRunResult> {
    const empty: ImportRunResult = { scanned: 0, processed: 0, skipped: 0, failed: 0, pending: 0, pages: [] };
    if (!cfg.enabled || !cfg.folder) return empty;
    if (this.running) return empty; // 이미 도는 중 — 겹쳐 돌면 같은 파일을 두 번 두뇌에 보낸다
    this.running = true;
    try {
      return await this.scan(cfg);
    } catch (err) {
      this.ports.log('error', `폴더 가져오기 스캔 실패: ${String(err)}`);
      return empty;
    } finally {
      this.running = false;
    }
  }

  private async scan(cfg: FolderImportConfig): Promise<ImportRunResult> {
    await this.ledger.load();
    const files = await this.ports.listFiles(cfg.folder);
    const result: ImportRunResult = { scanned: files.length, processed: 0, skipped: 0, failed: 0, pending: 0, pages: [] };

    for (const f of files) {
      const prev = this.ledger.get(f.rel);
      // 1차 관문: 크기·mtime이 그대로면 해시조차 계산하지 않는다(대용량 파일 매 스캔 전체읽기 방지).
      if (unchangedByStat(prev, f)) continue;

      if (f.size > cfg.maxFileBytes) {
        await this.record(f, undefined, { status: 'skipped', reason: REASON_TOO_LARGE });
        result.skipped++;
        continue;
      }

      let hash: string | undefined;
      try {
        hash = await this.ports.hashFile(f.absPath);
      } catch {
        hash = undefined; // 해시 실패 → mtime 기준으로 판정(아래 needsProcessing)
      }
      if (!needsProcessing(prev, { size: f.size, mtimeMs: f.mtimeMs, hash })) {
        // 내용은 그대로인데 mtime만 흔들린 경우 — 기록의 stat만 갱신하고 두뇌는 부르지 않는다.
        if (prev) await this.ledger.put({ ...prev, size: f.size, mtimeMs: f.mtimeMs, hash: hash ?? prev.hash });
        continue;
      }

      // 상한 도달 — 남은 파일은 '대기'로 남겨 다음 스캔이 이어받는다(조용한 무시 금지).
      if (result.processed >= cfg.maxFilesPerRun) {
        await this.record(f, hash, { status: 'pending' });
        result.pending++;
        continue;
      }

      const outcome = await this.processFile(f, hash, cfg, prev);
      if (outcome === 'done') {
        result.processed++;
        const rec = this.ledger.get(f.rel);
        if (rec?.pages) result.pages.push(...rec.pages);
      } else if (outcome === 'skipped') result.skipped++;
      else result.failed++;
    }

    return result;
  }

  /** 파일 하나 처리. 어떤 실패도 상태에 기록하고 'failed'/'skipped'로 돌려준다(never-throw). */
  private async processFile(
    f: ScannedFile,
    hash: string | undefined,
    cfg: FolderImportConfig,
    prev: ImportRecord | undefined,
  ): Promise<'done' | 'skipped' | 'failed'> {
    try {
      const extracted = await this.ports.extract(f, cfg);
      if ('skip' in extracted) {
        await this.record(f, hash, { status: 'skipped', reason: extracted.reason });
        return 'skipped';
      }
      const doc = extracted.doc;
      const imageOnly = !doc.text.trim() && !!doc.images?.length;

      const related = await this.findRelatedSafe(f.rel, doc.text);
      let pages: OrganizedPage[];
      if (cfg.mode === 'raw') {
        pages = rawPages({ rel: f.rel, text: doc.text, truncated: doc.truncated, existing: related });
        if (imageOnly) {
          // 원문 그대로 모드인데 이미지라 원문 텍스트가 없다 — 정리할 것이 없으므로 건너뜀으로 남긴다.
          await this.record(f, hash, { status: 'skipped', reason: 'imageNeedsAi' });
          return 'skipped';
        }
      } else {
        const prompt = buildOrganizePrompt({
          rel: f.rel, text: doc.text, truncated: doc.truncated, existing: related, imageOnly,
        });
        const res = await this.ports.organize(prompt, doc.images);
        if ('error' in res) {
          await this.recordFailure(f, hash, prev, `${REASON_ORGANIZE_FAILED}: ${res.error}`.slice(0, 200));
          return 'failed';
        }
        const parsed = parseOrganized(res.text);
        if (!parsed) {
          await this.recordFailure(f, hash, prev, REASON_ORGANIZE_PARSE);
          return 'failed';
        }
        pages = parsed.slice(0, MAX_PAGES_PER_FILE);
      }

      const known = new Set(related.map((r) => r.slug));
      const slugs: string[] = [];
      const proposals: string[] = [];
      let lastOp: 'create' | 'append' = 'create';
      const when = this.ports.now();

      for (const p of pages) {
        // 두뇌가 지어낸 slug는 실제 존재를 확인해야 append로 인정한다(없는 slug로 append하면
        // 제목·분류가 비어 있는 채 신규로 강등돼 이상한 페이지가 생긴다).
        if (p.slug && !known.has(p.slug) && (await this.pageExistsSafe(p.slug))) known.add(p.slug);
        const { slug, op } = resolveSlug(p, known);
        const submit: SubmitPage = {
          slug,
          op,
          title: p.title,
          category: p.category ?? 'import',
          body: `${p.body}${sourceFooter(f.rel, when)}`,
          sources: [sourceToken(f.rel)],
        };
        if (cfg.publish === 'direct') {
          await this.ports.publishNow(submit);
        } else {
          proposals.push(await this.ports.propose(submit));
        }
        slugs.push(slug);
        lastOp = op;
        known.add(slug); // 같은 파일이 만든 두 페이지가 같은 slug로 충돌하지 않게
      }

      await this.record(f, hash, {
        status: 'done',
        pages: slugs,
        op: lastOp,
        proposals: proposals.length ? proposals : undefined,
      });
      return 'done';
    } catch (err) {
      await this.recordFailure(f, hash, prev, String(err).slice(0, 200));
      return 'failed';
    }
  }

  /** 관련 문서 검색은 실패해도 변환을 막지 않는다(관련 문서 없이 새 페이지로 가면 될 뿐). */
  private async findRelatedSafe(rel: string, text: string): Promise<ExistingPage[]> {
    try {
      const query = `${titleFromRel(rel)} ${text.slice(0, RELATED_QUERY_CHARS)}`.trim();
      return await this.ports.findRelated(query);
    } catch (err) {
      this.ports.log('warn', `관련 문서 검색 실패(새 페이지로 진행): ${String(err)}`);
      return [];
    }
  }

  private async pageExistsSafe(slug: string): Promise<boolean> {
    try {
      return await this.ports.pageExists(slug);
    } catch {
      return false;
    }
  }

  private async record(f: ScannedFile, hash: string | undefined, patch: Partial<ImportRecord> & { status: ImportRecord['status'] }): Promise<void> {
    await this.ledger.put({
      rel: f.rel,
      name: f.name,
      size: f.size,
      mtimeMs: f.mtimeMs,
      hash,
      ts: this.ports.now().toISOString(),
      ...patch,
    });
  }

  /** 실패는 시도 횟수를 누적한다 — 같은 파일을 매 스캔마다 두뇌로 보내는 비용 폭주를 막는다. */
  private async recordFailure(
    f: ScannedFile,
    hash: string | undefined,
    prev: ImportRecord | undefined,
    reason: string,
  ): Promise<void> {
    // 내용이 바뀌었으면 시도 횟수를 리셋한다(고쳐서 다시 넣은 파일은 새 기회를 받는다).
    const sameContent = prev && hash !== undefined && prev.hash === hash;
    const attempts = (sameContent ? (prev?.attempts ?? 0) : 0) + 1;
    await this.record(f, hash, { status: 'failed', reason, attempts });
    if (attempts >= MAX_ATTEMPTS) {
      this.ports.log('warn', `가져오기 ${MAX_ATTEMPTS}회 실패 — 더 재시도하지 않음: ${f.rel} (${reason})`);
    }
  }
}
