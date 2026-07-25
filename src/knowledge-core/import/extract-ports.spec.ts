import { execFileSync } from 'child_process';
import { makeAudioText } from './extract-ports';

// 채택한 라이브러리가 이 레포의 실행 형태(CommonJS·Node 22)에서 실제로 도는지 못박는 테스트.
// 순수 로직 테스트가 아니라 "의존성 선택이 유효한가"를 지키는 회귀 그물이다.
//
// ★PDF만 자식 프로세스로 도는 이유: unpdf의 CJS 진입점은 내부에서 pdfjs.mjs를 동적 import하는데,
// jest의 VM은 --experimental-vm-modules 없이는 동적 ESM import를 막는다(jest 한계이지 런타임 문제가
// 아니다 — 백엔드가 실제로 도는 Electron utilityProcess에서는 동작을 실측 확인했다). 그래서 진짜
// Node로 한 번 돌려 라이브러리가 살아있는지만 검증한다.

/** 텍스트 한 줄이 들어있는 최소 PDF를 손으로 만든다(픽스처 바이너리를 레포에 두지 않기 위해). */
function makePdf(text: string): Uint8Array {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objs: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    4: `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  };
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** 진짜 Node에서 unpdf를 돌려 결과 문자열을 받아온다(jest VM 밖). */
function pdfTextInNode(pdf: Uint8Array): string {
  const script = `
    const { extractText, getDocumentProxy } = require('unpdf');
    const bytes = Buffer.from(process.argv[1], 'base64');
    (async () => {
      const doc = await getDocumentProxy(new Uint8Array(bytes));
      const out = await extractText(doc, { mergePages: true });
      process.stdout.write(String(out.text ?? ''));
    })().catch((e) => { process.stderr.write(String(e)); process.exit(3); });
  `;
  return execFileSync(process.execPath, ['-e', script, Buffer.from(pdf).toString('base64')], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('pdfText(unpdf) — 실 라이브러리가 이 레포에서 도는가', () => {
  it('PDF에서 텍스트를 뽑는다', () => {
    expect(pdfTextInNode(makePdf('Hello Engram folder import'))).toContain('Hello Engram folder import');
  }, 90_000);

  it('PDF가 아닌 바이트는 예외 — 호출부(extractFile)가 건너뜀으로 흡수한다', () => {
    expect(() => pdfTextInNode(new Uint8Array(Buffer.from('not a pdf')))).toThrow();
  }, 90_000);
});

describe('makeAudioText — 기존 Whisper(stt.ts)를 그대로 재사용', () => {
  it('wav는 전사 엔진에 바이트를 그대로 넘긴다(SttEngine이 RIFF를 직접 푼다)', async () => {
    const seen: unknown[] = [];
    const stt = { transcribe: async (a: unknown) => { seen.push(a); return { ok: true as const, text: '받아쓴 내용', ms: 1 }; } };
    const audioText = makeAudioText(stt);
    expect(await audioText(new Uint8Array([1, 2, 3]), '.wav')).toBe('받아쓴 내용');
    expect(seen[0]).toBeInstanceOf(Uint8Array);
  });

  it('전사 실패({error})는 예외로 올려 호출부가 건너뜀으로 기록하게 한다', async () => {
    const stt = { transcribe: async () => ({ error: '모델 다운로드 실패' }) };
    await expect(makeAudioText(stt)(new Uint8Array([1]), '.wav')).rejects.toThrow('모델 다운로드 실패');
  });

  it('언어 설정을 전사 엔진에 전달한다', async () => {
    let opts: unknown;
    const stt = { transcribe: async (_a: unknown, o?: unknown) => { opts = o; return { ok: true as const, text: 't', ms: 1 }; } };
    await makeAudioText(stt, 'ko')(new Uint8Array([1]), '.wav');
    expect(opts).toMatchObject({ language: 'ko' });
  });
});
