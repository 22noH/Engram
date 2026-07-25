import { unzipSync } from 'fflate';

// 폴더→위키 변환의 "파일 → 텍스트" 추출기 모음(형식별 순수 함수).
// 여기 있는 함수는 전부 바이트/문자열만 받고 파일시스템·네트워크·두뇌를 모르는 순수 함수다.
// 상위 디스패치(extract-file.ts)가 확장자로 이 중 하나를 고르고, 실제 I/O가 필요한 형식
// (pdf·음성)만 주입된 포트로 넘긴다 — 그래야 유닛테스트가 무거운 wasm/모델을 안 건드린다.
//
// zip+xml 계열(docx·pptx·xlsx·hwpx)을 라이브러리 4개가 아니라 fflate 하나로 처리하는 이유:
// 우리가 필요한 건 "AI가 읽을 텍스트"지 서식 충실도가 아니다. OOXML/HWPX는 전부 zip 안의 XML이라
// 압축해제 1개 + XML 텍스트화 1개면 네 형식이 동시에 커버된다(설치 용량 833KB, 네이티브 빌드 0).

/** 파일 하나에서 뽑아낸 것. images가 있으면 두뇌 vision 경로로 간다(스캔·사진). */
export interface ExtractedImage {
  mime: string;
  dataBase64: string;
}
export interface ExtractedDoc {
  text: string;
  images?: ExtractedImage[];
  truncated?: boolean;
}
/** 성공 아니면 "건너뜀 + 이유". 조용한 무시는 없다(목업의 빨간 배지). */
export type ExtractOutcome = { ok: true; doc: ExtractedDoc } | { skip: true; reason: string };

/** 확장자로 가른 처리 갈래. 'unknown'은 건너뜀 대상. */
export type FileKind = 'text' | 'html' | 'pdf' | 'ooxml' | 'hwpx' | 'hwp' | 'image' | 'audio' | 'unknown';

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.mdx', '.csv', '.tsv', '.json', '.jsonl', '.log',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.xml', '.srt', '.vtt', '.rst', '.tex',
  // 코드 파일 — 사용자가 "코드 파일"을 명시적으로 골랐다.
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.go', '.rs', '.c', '.h', '.cc',
  '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.bash', '.zsh', '.ps1', '.sql', '.css', '.scss',
  '.less', '.swift', '.kt', '.kts', '.lua', '.r', '.pl', '.vue', '.svelte', '.dart', '.scala', '.gradle',
]);
const HTML_EXTS = new Set(['.html', '.htm', '.xhtml']);
const OOXML_EXTS = new Set(['.docx', '.pptx', '.xlsx']);
const IMAGE_EXTS = new Map<string, string>([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'],
]);
const AUDIO_EXTS = new Set(['.wav', '.mp3', '.m4a', '.mp4a', '.aac']);

/** 파일명 → 확장자(소문자, 점 포함). 확장자가 없으면 ''. */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i).toLowerCase();
}

/** 확장자 → 처리 갈래. 상위 디스패치가 이걸로 추출기를 고른다. */
export function classify(name: string): FileKind {
  const ext = extOf(name);
  if (TEXT_EXTS.has(ext)) return 'text';
  if (HTML_EXTS.has(ext)) return 'html';
  if (ext === '.pdf') return 'pdf';
  if (OOXML_EXTS.has(ext)) return 'ooxml';
  if (ext === '.hwpx') return 'hwpx';
  if (ext === '.hwp') return 'hwp'; // 구형 한글 — 바이너리 복합문서, 안정적으로 못 읽는다(명시적 건너뜀)
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'unknown';
}

/** 이미지 확장자 → mime(두뇌 vision 화이트리스트와 동일 집합). 아니면 null. */
export function imageMime(name: string): string | null {
  return IMAGE_EXTS.get(extOf(name)) ?? null;
}

/**
 * 바이트 → 문자열. BOM(UTF-8/UTF-16 LE·BE)을 보고 인코딩을 정한다.
 * BOM이 없으면 UTF-8로 읽는다(한국어 CP949 레거시 파일은 깨질 수 있으나, 깨진 티가 나는 편이
 * 조용히 잘못 저장되는 것보다 낫다 — 치환문자 비율이 높으면 호출부가 건너뜀으로 돌린다).
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return Buffer.from(bytes.subarray(3)).toString('utf8');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return Buffer.from(bytes.subarray(2)).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16 BE — Node엔 디코더가 없어 바이트를 뒤집어 LE로 읽는다.
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * 텍스트가 사실상 바이너리인지(널바이트·치환문자 과다). 확장자를 믿고 읽었는데 실제로는
 * 바이너리인 파일이 위키에 쓰레기로 들어가는 걸 막는다.
 */
export function looksBinary(text: string): boolean {
  if (!text) return false;
  const sample = text.slice(0, 4096);
  if (sample.includes('\u0000')) return true;
  const bad = (sample.match(/�/g) ?? []).length;
  return bad > sample.length * 0.1;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
};

/** XML/HTML 엔티티 디코드(숫자 참조 포함). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** 빈 줄이 3줄 이상 이어지면 2줄로 줄이고 양끝 공백을 턴다(위키 본문 위생). */
export function tidy(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 문단 경계로 볼 닫는 태그들(네임스페이스 접두사 허용). docx(w:p)·pptx(a:p)·hwpx(hp:p)·ODF(text:p) 공통.
const PARA_CLOSE = /<\/(?:[a-zA-Z0-9]+:)?(?:p|br|tr|tc)>/g;
const LINE_BREAK = /<(?:[a-zA-Z0-9]+:)?(?:br|cr)\s*\/>/g;
const TAB = /<(?:[a-zA-Z0-9]+:)?tab\s*\/>/g;

/**
 * XML 조각 → 사람이 읽는 텍스트. 문단 태그는 개행으로, 나머지 태그는 제거, 엔티티는 디코드.
 * docx·pptx·hwpx가 전부 이 한 함수를 공유한다(태그 이름만 다를 뿐 구조가 같다).
 */
export function xmlToText(xml: string): string {
  const out = xml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(TAB, '\t')
    .replace(LINE_BREAK, '\n')
    .replace(PARA_CLOSE, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t]{2,}/g, ' ');
  return tidy(decodeEntities(out));
}

/** HTML → 텍스트. script/style은 통째로 버리고 블록 태그는 개행으로. */
export function htmlToText(html: string): string {
  const out = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t]{2,}/g, ' ');
  return tidy(decodeEntities(out));
}

/**
 * zip 바이트에서 원하는 엔트리만 풀어 { 경로: 바이트 } 로 준다. never-throw — 깨진 zip은 null.
 * filter로 필요한 XML만 푸는 게 핵심(수백 MB짜리 xlsx의 이미지까지 메모리에 올리지 않는다).
 */
export function unzipEntries(bytes: Uint8Array, wanted: (name: string) => boolean): Record<string, Uint8Array> | null {
  try {
    return unzipSync(bytes, { filter: (f) => wanted(f.name) });
  } catch {
    return null;
  }
}

/** zip 엔트리 이름을 숫자 접미(slide2 < slide10)를 존중해 정렬한다. */
export function naturalSort(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const na = Number(a.match(/(\d+)\D*$/)?.[1] ?? NaN);
    const nb = Number(b.match(/(\d+)\D*$/)?.[1] ?? NaN);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.localeCompare(b);
  });
}

/** docx: word/document.xml 본문(+각주·머리말은 붙이지 않는다 — 본문이 지식의 전부). */
export function docxText(bytes: Uint8Array): ExtractOutcome {
  const zip = unzipEntries(bytes, (n) => n === 'word/document.xml');
  if (!zip) return { skip: true, reason: 'damagedZip' };
  const doc = zip['word/document.xml'];
  if (!doc) return { skip: true, reason: 'notDocx' };
  const text = xmlToText(decodeText(doc));
  return text ? { ok: true, doc: { text } } : { skip: true, reason: 'noText' };
}

/** pptx: 슬라이드별 텍스트를 "## Slide N"으로 묶는다(주제 분할의 자연스러운 힌트). */
export function pptxText(bytes: Uint8Array): ExtractOutcome {
  const zip = unzipEntries(bytes, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  if (!zip) return { skip: true, reason: 'damagedZip' };
  const names = naturalSort(Object.keys(zip));
  if (names.length === 0) return { skip: true, reason: 'notPptx' };
  const parts: string[] = [];
  names.forEach((n, i) => {
    const t = xmlToText(decodeText(zip[n]));
    if (t) parts.push(`## Slide ${i + 1}\n${t}`);
  });
  const text = parts.join('\n\n');
  return text ? { ok: true, doc: { text } } : { skip: true, reason: 'noText' };
}

/** xlsx의 공유 문자열 테이블(<si> 순서 = 인덱스). 셀이 t="s"면 여기 인덱스를 가리킨다. */
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    out.push(xmlToText(m[1]).replace(/\n+/g, ' ').trim());
  }
  return out;
}

/** xlsx 시트 XML → 행/열 텍스트(탭 구분). 셀 타입 s(공유문자열)·inlineStr·그 외(<v> 원값) 처리. */
export function parseSheet(xml: string, shared: string[]): string {
  const rows: string[] = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1];
      const body = cm[2];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      if (type === 's') {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? NaN);
        cells.push(Number.isFinite(idx) ? (shared[idx] ?? '') : '');
      } else if (type === 'inlineStr') {
        cells.push(xmlToText(body).replace(/\n+/g, ' ').trim());
      } else {
        cells.push(decodeEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '').trim());
      }
    }
    // 자기닫힘 셀(<c r="A1"/>)은 빈 칸 — 위 정규식이 안 잡으므로 행이 통째로 비면 버린다.
    if (cells.some((c) => c !== '')) rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

/** xlsx: 시트별 텍스트를 탭 구분 표로. 시트 이름은 workbook.xml에서 순서대로 가져온다. */
export function xlsxText(bytes: Uint8Array): ExtractOutcome {
  const zip = unzipEntries(
    bytes,
    (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  );
  if (!zip) return { skip: true, reason: 'damagedZip' };
  const sheetNames = naturalSort(Object.keys(zip).filter((n) => n.startsWith('xl/worksheets/')));
  if (sheetNames.length === 0) return { skip: true, reason: 'notXlsx' };
  const shared = zip['xl/sharedStrings.xml'] ? parseSharedStrings(decodeText(zip['xl/sharedStrings.xml'])) : [];
  const titles: string[] = [];
  if (zip['xl/workbook.xml']) {
    for (const m of decodeText(zip['xl/workbook.xml']).matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)) {
      titles.push(decodeEntities(m[1]));
    }
  }
  const parts: string[] = [];
  sheetNames.forEach((n, i) => {
    const body = parseSheet(decodeText(zip[n]), shared);
    if (body) parts.push(`## ${titles[i] ?? `Sheet ${i + 1}`}\n${body}`);
  });
  const text = parts.join('\n\n');
  return text ? { ok: true, doc: { text } } : { skip: true, reason: 'noText' };
}

/** hwpx(신형 한글, zip+xml): Contents/section*.xml의 <hp:p> 문단. 구형 .hwp는 여기 오지 않는다. */
export function hwpxText(bytes: Uint8Array): ExtractOutcome {
  const zip = unzipEntries(bytes, (n) => /^Contents\/section\d+\.xml$/i.test(n));
  if (!zip) return { skip: true, reason: 'damagedZip' };
  const names = naturalSort(Object.keys(zip));
  if (names.length === 0) return { skip: true, reason: 'notHwpx' };
  const text = tidy(names.map((n) => xmlToText(decodeText(zip[n]))).join('\n\n'));
  return text ? { ok: true, doc: { text } } : { skip: true, reason: 'noText' };
}
