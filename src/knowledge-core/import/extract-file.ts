import {
  ExtractOutcome, classify, decodeText, docxText, extOf, htmlToText, hwpxText,
  imageMime, looksBinary, pptxText, tidy, xlsxText,
} from './extractors';

// 상위 디스패치: 파일 하나 → ExtractOutcome. 확장자로 갈래를 정하고, 실제 I/O가 필요한
// 형식(pdf 파서·음성 전사)은 주입된 포트로 넘긴다. 포트가 없으면 조용히 무시하지 않고
// "건너뜀 + 이유"로 남긴다(레포 never-throw 관례 — 여기서 throw가 나가면 안 된다).

/** 두뇌 vision 제공자 상한(reader-agent.ts VISION_IMAGE_CAP과 동일값·동일 이유). */
export const VISION_IMAGE_CAP = 4.5 * 1024 * 1024;

/**
 * 텍스트(공백 제외)가 이만큼도 안 나오면 "스캔본/빈 문서"로 본다(PDF 판정에만 쓴다).
 * 낮게 잡은 이유: 짧은 한 장짜리 안내문도 진짜 문서다 — 스캔본은 보통 0~2자만 나온다.
 */
const PDF_MIN_TEXT = 12;

export interface ExtractPorts {
  /** 파일 바이트 읽기. */
  readFile(absPath: string): Promise<Uint8Array>;
  /** PDF → 텍스트(unpdf 주입). 미주입이면 pdf는 건너뜀. */
  pdfText?(bytes: Uint8Array): Promise<string>;
  /** 오디오 → 전사 텍스트(로컬 Whisper 주입). 미주입이면 음성은 건너뜀. */
  audioText?(bytes: Uint8Array, ext: string): Promise<string>;
}

export interface ExtractOptions {
  /** 본문 텍스트 상한(초과분은 잘라내고 truncated 표시 — 비용 폭주 방지). */
  maxTextChars: number;
}

/**
 * 건너뜀 사유 코드 → 사람이 읽는 이유는 UI(설정창)에서 로케일별로 붙인다.
 * 여기서는 코드만 남긴다(상태 파일이 언어에 묶이지 않게).
 */
export const SKIP_REASONS = {
  unsupported: 'unsupported',       // 아는 확장자 목록에 없음
  legacyHwp: 'legacyHwp',           // 구형 .hwp — 안정적으로 못 읽는다
  noPdfParser: 'noPdfParser',
  noAudioEngine: 'noAudioEngine',
  compressedAudio: 'compressedAudio', // m4a/aac — 라이선스 호환 순수 JS 디코더 없음
  scannedPdf: 'scannedPdf',         // 텍스트층이 없는 PDF(스캔본)
  imageTooLarge: 'imageTooLarge',
  binary: 'binary',                 // 텍스트인 줄 알았는데 바이너리
  empty: 'empty',                   // 내용이 없음
  unreadable: 'unreadable',         // 읽기 실패
  damagedZip: 'damagedZip',
  noText: 'noText',
} as const;

/** 상한을 넘으면 잘라내고 표시한다. 자르는 위치는 문자 기준(토큰 아님 — 넉넉히 잡는다). */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (max <= 0 || text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/** m4a/aac인지(압축 오디오 중 우리가 못 푸는 것). */
function isUndecodableAudio(ext: string): boolean {
  return ext === '.m4a' || ext === '.mp4a' || ext === '.aac';
}

/**
 * 파일 하나를 텍스트(또는 vision 이미지)로 만든다. 절대 throw하지 않는다 —
 * 어떤 실패든 { skip, reason }으로 돌려 호출부가 상태에 기록하고 다음 파일로 넘어가게 한다.
 */
export async function extractFile(
  absPath: string,
  name: string,
  ports: ExtractPorts,
  opts: ExtractOptions,
): Promise<ExtractOutcome> {
  const kind = classify(name);
  if (kind === 'unknown') return { skip: true, reason: SKIP_REASONS.unsupported };
  if (kind === 'hwp') return { skip: true, reason: SKIP_REASONS.legacyHwp };

  const ext = extOf(name);
  if (kind === 'audio' && isUndecodableAudio(ext)) return { skip: true, reason: SKIP_REASONS.compressedAudio };
  if (kind === 'pdf' && !ports.pdfText) return { skip: true, reason: SKIP_REASONS.noPdfParser };
  if (kind === 'audio' && !ports.audioText) return { skip: true, reason: SKIP_REASONS.noAudioEngine };

  let bytes: Uint8Array;
  try {
    bytes = await ports.readFile(absPath);
  } catch {
    return { skip: true, reason: SKIP_REASONS.unreadable };
  }
  if (bytes.length === 0) return { skip: true, reason: SKIP_REASONS.empty };

  try {
    switch (kind) {
      case 'text': {
        const raw = decodeText(bytes);
        if (looksBinary(raw)) return { skip: true, reason: SKIP_REASONS.binary };
        return finish(tidy(raw), opts);
      }
      case 'html':
        return finish(htmlToText(decodeText(bytes)), opts);
      case 'ooxml': {
        const out = ext === '.docx' ? docxText(bytes) : ext === '.pptx' ? pptxText(bytes) : xlsxText(bytes);
        if ('skip' in out) return out;
        return finish(out.doc.text, opts);
      }
      case 'hwpx': {
        const out = hwpxText(bytes);
        if ('skip' in out) return out;
        return finish(out.doc.text, opts);
      }
      case 'pdf': {
        const text = tidy(await ports.pdfText!(bytes));
        // 텍스트층이 없는 PDF = 스캔본. 우리는 PDF 페이지를 그림으로 만들 수단이 없다
        // (렌더러는 canvas 네이티브 의존을 끌고 온다) — 조용히 빈 페이지를 만드는 대신 명확히 알린다.
        if (text.replace(/\s/g, '').length < PDF_MIN_TEXT) return { skip: true, reason: SKIP_REASONS.scannedPdf };
        return finish(text, opts);
      }
      case 'image': {
        const mime = imageMime(name);
        if (!mime) return { skip: true, reason: SKIP_REASONS.unsupported };
        if (bytes.length > VISION_IMAGE_CAP) return { skip: true, reason: SKIP_REASONS.imageTooLarge };
        // 이미지는 텍스트가 없다 — 두뇌가 "보고" 정리하도록 vision 블록으로 넘긴다
        // (reader-agent.ts의 첨부 이미지 경로와 동일한 계약: CompleteOpts.images).
        return { ok: true, doc: { text: '', images: [{ mime, dataBase64: Buffer.from(bytes).toString('base64') }] } };
      }
      case 'audio': {
        const text = tidy(await ports.audioText!(bytes, ext));
        return finish(text, opts);
      }
      default:
        return { skip: true, reason: SKIP_REASONS.unsupported };
    }
  } catch {
    // 파서·전사 엔진이 던진 어떤 예외도 여기서 흡수한다(한 파일 실패가 감시를 죽이면 안 된다).
    return { skip: true, reason: SKIP_REASONS.unreadable };
  }
}

function finish(text: string, opts: ExtractOptions): ExtractOutcome {
  if (!text.trim()) return { skip: true, reason: SKIP_REASONS.noText };
  const capped = capText(text, opts.maxTextChars);
  return { ok: true, doc: { text: capped.text, truncated: capped.truncated } };
}
