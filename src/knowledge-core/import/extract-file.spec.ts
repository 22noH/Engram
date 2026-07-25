import { strToU8, zipSync } from 'fflate';
import { ExtractPorts, SKIP_REASONS, VISION_IMAGE_CAP, capText, extractFile } from './extract-file';

const u8 = (s: string): Uint8Array => strToU8(s);
const opts = { maxTextChars: 100 };

function ports(over: Partial<ExtractPorts> = {}, bytes: Uint8Array = u8('hello')): ExtractPorts {
  return { readFile: async () => bytes, ...over };
}

describe('extractFile — 지원 형식', () => {
  it('txt/md/코드는 그대로 텍스트', async () => {
    const out = await extractFile('/x/a.md', 'a.md', ports({}, u8('# 제목\n본문')), opts);
    expect(out).toEqual({ ok: true, doc: { text: '# 제목\n본문', truncated: false } });
  });

  it('html은 태그를 벗겨 텍스트로', async () => {
    const out = await extractFile('/x/a.html', 'a.html', ports({}, u8('<p>안녕</p>')), opts);
    expect(out).toEqual({ ok: true, doc: { text: '안녕', truncated: false } });
  });

  it('docx는 zip+xml에서 본문을 뽑는다', async () => {
    const zip = zipSync({ 'word/document.xml': u8('<w:p><w:t>워드 본문</w:t></w:p>') });
    const out = await extractFile('/x/a.docx', 'a.docx', ports({}, zip), opts);
    expect(out).toEqual({ ok: true, doc: { text: '워드 본문', truncated: false } });
  });

  it('hwpx는 읽고 구형 hwp는 명확히 건너뛴다', async () => {
    const zip = zipSync({ 'Contents/section0.xml': u8('<hp:p><hp:t>한글</hp:t></hp:p>') });
    expect(await extractFile('/x/a.hwpx', 'a.hwpx', ports({}, zip), opts))
      .toEqual({ ok: true, doc: { text: '한글', truncated: false } });
    expect(await extractFile('/x/a.hwp', 'a.hwp', ports(), opts))
      .toEqual({ skip: true, reason: SKIP_REASONS.legacyHwp });
  });

  it('pdf는 주입된 파서를 쓴다', async () => {
    const text = '배포 가이드 문서의 본문입니다. 여기에 실제 내용이 들어갑니다.';
    const out = await extractFile('/x/a.pdf', 'a.pdf', ports({ pdfText: async () => text }), opts);
    expect(out).toEqual({ ok: true, doc: { text, truncated: false } });
  });

  it('텍스트층이 없는 pdf(스캔본)는 빈 페이지 대신 건너뜀', async () => {
    const out = await extractFile('/x/a.pdf', 'a.pdf', ports({ pdfText: async () => '   \n ' }), opts);
    expect(out).toEqual({ skip: true, reason: SKIP_REASONS.scannedPdf });
  });

  it('이미지는 vision 블록으로 넘긴다(두뇌가 보고 정리)', async () => {
    const out = await extractFile('/x/a.png', 'a.png', ports({}, new Uint8Array([1, 2, 3])), opts);
    expect(out).toEqual({
      ok: true,
      doc: { text: '', images: [{ mime: 'image/png', dataBase64: Buffer.from([1, 2, 3]).toString('base64') }] },
    });
  });

  it('vision 상한을 넘는 이미지는 이유와 함께 건너뛴다', async () => {
    const big = new Uint8Array(VISION_IMAGE_CAP + 1);
    const out = await extractFile('/x/a.jpg', 'a.jpg', ports({}, big), opts);
    expect(out).toEqual({ skip: true, reason: SKIP_REASONS.imageTooLarge });
  });

  it('음성은 주입된 전사 엔진을 쓴다', async () => {
    const out = await extractFile('/x/a.wav', 'a.wav', ports({ audioText: async () => '녹음 내용' }), opts);
    expect(out).toEqual({ ok: true, doc: { text: '녹음 내용', truncated: false } });
  });
});

describe('extractFile — 건너뜀은 반드시 이유를 남긴다(조용한 무시 금지)', () => {
  it('모르는 형식', async () => {
    expect(await extractFile('/x/a.exe', 'a.exe', ports(), opts))
      .toEqual({ skip: true, reason: SKIP_REASONS.unsupported });
  });

  it('m4a/aac는 라이선스 호환 디코더가 없어 명확히 건너뛴다', async () => {
    expect(await extractFile('/x/a.m4a', 'a.m4a', ports({ audioText: async () => 'x' }), opts))
      .toEqual({ skip: true, reason: SKIP_REASONS.compressedAudio });
  });

  it('파서/엔진이 없으면 그 사실을 이유로 남긴다', async () => {
    expect(await extractFile('/x/a.pdf', 'a.pdf', ports(), opts))
      .toEqual({ skip: true, reason: SKIP_REASONS.noPdfParser });
    expect(await extractFile('/x/a.mp3', 'a.mp3', ports(), opts))
      .toEqual({ skip: true, reason: SKIP_REASONS.noAudioEngine });
  });

  it('읽기 실패·빈 파일·바이너리', async () => {
    const boom: ExtractPorts = { readFile: async () => { throw new Error('EACCES'); } };
    expect(await extractFile('/x/a.txt', 'a.txt', boom, opts))
      .toEqual({ skip: true, reason: SKIP_REASONS.unreadable });
    expect(await extractFile('/x/a.txt', 'a.txt', ports({}, new Uint8Array(0)), opts))
      .toEqual({ skip: true, reason: SKIP_REASONS.empty });
    expect(await extractFile('/x/a.txt', 'a.txt', ports({}, new Uint8Array([0x61, 0x00, 0x62])), opts))
      .toEqual({ skip: true, reason: SKIP_REASONS.binary });
  });

  it('추출기가 던진 예외를 흡수한다(한 파일 실패가 감시를 죽이지 않는다)', async () => {
    const out = await extractFile('/x/a.pdf', 'a.pdf', ports({ pdfText: async () => { throw new Error('corrupt'); } }), opts);
    expect(out).toEqual({ skip: true, reason: SKIP_REASONS.unreadable });
  });
});

describe('extractFile — 상한', () => {
  it('capText는 상한을 넘으면 자르고 표시한다', () => {
    expect(capText('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(capText('ab', 3)).toEqual({ text: 'ab', truncated: false });
    expect(capText('ab', 0)).toEqual({ text: 'ab', truncated: false });
  });

  it('긴 문서는 잘라서 처리하고 truncated를 남긴다', async () => {
    const long = 'ㄱ'.repeat(500);
    const out = await extractFile('/x/a.txt', 'a.txt', ports({}, u8(long)), { maxTextChars: 10 });
    expect(out).toEqual({ ok: true, doc: { text: 'ㄱ'.repeat(10), truncated: true } });
  });
});
