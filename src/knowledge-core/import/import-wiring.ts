import { ExtractedImage } from './extractors';
import { ExtractPorts, extractFile } from './extract-file';
import { FolderImportConfig } from './import.config';
import { ExistingPage } from './organizer';
import { ImporterPorts, ScannedFile, SubmitPage } from './folder-importer';
import { hashFile, listFolder } from './scan-folder';

// 실 서비스(두뇌·위키·제안함) ↔ FolderImporter 사이의 얇은 어댑터.
// 구조적 타입(클로저)만 받는다 — knowledge-core가 src/brain·src/edge를 역의존하지 않게
// (wiki-merge.ts의 BrainLike와 같은 관례). 그래서 앱 배선(src/main.ts)도, 앞으로의 MCP 노출도
// 같은 팩토리 하나를 서로 다른 클로저로 채우기만 하면 된다.

/** 두뇌 최소 계약(BrainProvider와 구조적으로 호환). */
export interface ImportBrain {
  complete(
    prompt: string,
    onChunk?: (t: string) => void,
    opts?: { images?: ExtractedImage[] },
  ): Promise<{ text: string; isError: boolean }>;
}

/** 위키 최소 계약(WikiEngine과 구조적으로 호환). */
export interface ImportWiki {
  getPage(slug: string, userId?: string): Promise<{ slug: string; body: string; frontmatter: { sources: string[] } } | null>;
  createPage(
    input: { slug: string; title: string; category: string; body: string; sources: string[]; status?: 'draft' | 'published' },
    userId?: string,
  ): Promise<unknown>;
  updatePage(slug: string, patch: { body?: string; sources?: string[] }, userId?: string): Promise<unknown>;
  search(query: string, limit?: number, userId?: string): Promise<Array<{ slug: string; title: string; text: string }>>;
}

/** 제안함 최소 계약(ProposalStore와 구조적으로 호환). */
export interface ImportProposals {
  enqueue(p: {
    userId: string;
    op: 'create' | 'append' | 'supersede';
    targetSlug: string;
    title: string;
    category: string;
    payload: string;
    sources: string[];
    importance: number;
    verdict: { confidence: number; reason: string };
  }): Promise<{ id: string }>;
}

export interface ImportWiringDeps {
  brain: ImportBrain;
  wiki: ImportWiki;
  proposals: ImportProposals;
  userId: string;
  /** pdf·음성 등 무거운 추출기(extract-ports.ts). 미주입 항목은 "건너뜀 + 이유"가 된다. */
  extract: ExtractPorts;
  log: (level: 'log' | 'warn' | 'error', msg: string) => void;
  now?: () => Date;
  /** 관련 문서 검색 개수 — 두뇌 프롬프트에 실리는 기존 페이지 후보 수. */
  relatedLimit?: number;
}

/** 이 파일이 만들어내는 위키 페이지의 기본 분류(두뇌가 안 정하면). */
const DEFAULT_CATEGORY = 'import';

/**
 * 실 서비스로 ImporterPorts를 조립한다. 여기 있는 모든 함수는 FolderImporter가 try로 감싸므로
 * 실패해도 스캔 전체가 죽지 않는다 — 다만 두뇌 호출만은 never-throw 규약({text}|{error})을 지킨다.
 */
export function makeImporterPorts(deps: ImportWiringDeps): ImporterPorts {
  const now = deps.now ?? ((): Date => new Date());
  const relatedLimit = deps.relatedLimit ?? 5;

  return {
    listFiles: (folder: string): Promise<ScannedFile[]> => listFolder(folder),
    hashFile,

    extract: (file: ScannedFile, cfg: FolderImportConfig) =>
      extractFile(file.absPath, file.name, deps.extract, { maxTextChars: cfg.maxTextChars }),

    organize: async (prompt: string, images?: ExtractedImage[]) => {
      try {
        const r = await deps.brain.complete(prompt, undefined, images?.length ? { images } : undefined);
        if (r.isError) return { error: r.text?.slice(0, 200) || 'brain error' };
        return { text: r.text };
      } catch (e) {
        return { error: String(e).slice(0, 200) };
      }
    },

    findRelated: async (query: string): Promise<ExistingPage[]> => {
      const hits = await deps.wiki.search(query, relatedLimit, deps.userId);
      return hits.map((h) => ({ slug: h.slug, title: h.title, snippet: h.text }));
    },

    pageExists: async (slug: string): Promise<boolean> => (await deps.wiki.getPage(slug, deps.userId)) !== null,

    propose: async (p: SubmitPage): Promise<string> => {
      const r = await deps.proposals.enqueue({
        userId: deps.userId,
        op: p.op,
        targetSlug: p.slug,
        title: p.title,
        category: p.category || DEFAULT_CATEGORY,
        payload: p.body,
        sources: p.sources,
        importance: 3,
        verdict: { confidence: 0.6, reason: `folder import: ${p.sources.join(', ')}` },
      });
      return r.id;
    },

    // '바로 게시' 모드. 승인함을 거치지 않으므로 여기서 직접 위키를 바꾼다 — 대상이 이미 있으면
    // 통째 교체가 아니라 덧붙이기(설계 §6의 통째교체 금지 원칙, ProposalApplier와 동일한 결).
    publishNow: async (p: SubmitPage): Promise<void> => {
      const existing = await deps.wiki.getPage(p.slug, deps.userId);
      if (!existing) {
        await deps.wiki.createPage(
          { slug: p.slug, title: p.title, category: p.category || DEFAULT_CATEGORY, body: p.body, sources: p.sources, status: 'published' },
          deps.userId,
        );
        return;
      }
      const sources = [...new Set([...existing.frontmatter.sources, ...p.sources])];
      await deps.wiki.updatePage(p.slug, { body: `${existing.body}\n\n${p.body}`, sources }, deps.userId);
    },

    now,
    log: deps.log,
  };
}
