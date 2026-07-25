import { zipSync, strToU8 } from 'fflate';
import {
  classify, decodeEntities, decodeText, docxText, extOf, htmlToText, hwpxText, imageMime,
  looksBinary, naturalSort, parseSharedStrings, parseSheet, pptxText, tidy, xlsxText, xmlToText,
} from './extractors';

const u8 = (s: string): Uint8Array => strToU8(s);

describe('extractors — 확장자 분류', () => {
  it('바로 되는 텍스트 계열을 text로 가른다', () => {
    for (const n of ['a.txt', 'a.md', 'a.csv', 'a.json', 'a.log', 'a.ts', 'a.py', 'a.YAML']) {
      expect(classify(n)).toBe('text');
    }
  });

  it('형식별 갈래를 정확히 가른다', () => {
    expect(classify('a.html')).toBe('html');
    expect(classify('a.pdf')).toBe('pdf');
    expect(classify('a.docx')).toBe('ooxml');
    expect(classify('a.pptx')).toBe('ooxml');
    expect(classify('a.xlsx')).toBe('ooxml');
    expect(classify('보고서.hwpx')).toBe('hwpx');
    expect(classify('보고서.hwp')).toBe('hwp'); // 구형 — 억지로 읽지 않는다
    expect(classify('a.png')).toBe('image');
    expect(classify('a.mp3')).toBe('audio');
    expect(classify('a.wav')).toBe('audio');
  });

  it('모르는 형식은 unknown — 호출부가 이유를 남긴다', () => {
    expect(classify('a.exe')).toBe('unknown');
    expect(classify('a.zip')).toBe('unknown');
    expect(classify('LICENSE')).toBe('unknown'); // 확장자 없음
  });

  it('extOf/imageMime', () => {
    expect(extOf('a.b.PNG')).toBe('.png');
    expect(extOf('noext')).toBe('');
    expect(extOf('.gitignore')).toBe(''); // 앞점은 확장자가 아니다
    expect(imageMime('x.jpeg')).toBe('image/jpeg');
    expect(imageMime('x.bmp')).toBeNull();
  });
});

describe('extractors — 텍스트 디코딩', () => {
  it('UTF-8 BOM을 벗기고 읽는다', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...u8('안녕')]);
    expect(decodeText(bytes)).toBe('안녕');
  });

  it('UTF-16 LE/BE BOM을 처리한다', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('가나', 'utf16le')]);
    expect(decodeText(new Uint8Array(le))).toBe('가나');
    const beBody = Buffer.from('가나', 'utf16le');
    beBody.swap16();
    expect(decodeText(new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), beBody])))).toBe('가나');
  });

  it('널바이트가 섞이면 바이너리로 본다', () => {
    expect(looksBinary('hello')).toBe(false);
    expect(looksBinary('he'+String.fromCharCode(0)+'llo')).toBe(true);
  });

  it('엔티티를 디코드한다(숫자 참조 포함)', () => {
    expect(decodeEntities('a&amp;b&lt;c&gt;d&#65;&#x42;')).toBe('a&b<c>dAB');
    expect(decodeEntities('&unknown;')).toBe('&unknown;'); // 모르는 건 그대로
  });

  it('tidy가 빈 줄과 꼬리 공백을 정리한다', () => {
    expect(tidy('a  \n\n\n\nb\n')).toBe('a\n\nb');
  });
});

describe('extractors — XML/HTML', () => {
  it('문단 태그를 개행으로, 나머지는 제거한다', () => {
    const xml = '<w:document><w:p><w:r><w:t>첫 줄</w:t></w:r></w:p><w:p><w:r><w:t>둘째</w:t></w:r></w:p></w:document>';
    expect(xmlToText(xml)).toBe('첫 줄\n둘째');
  });

  it('탭·줄바꿈 자기닫힘 태그를 반영한다', () => {
    expect(xmlToText('<w:p><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:p>')).toBe('a\tb\nc');
  });

  it('HTML의 script/style을 버리고 블록을 개행으로', () => {
    const html = '<html><head><style>p{color:red}</style><script>var x=1;</script></head><body><p>안녕</p><ul><li>하나</li><li>둘</li></ul></body></html>';
    expect(htmlToText(html)).toBe('안녕\n- 하나\n- 둘');
  });

  it('naturalSort는 slide2 < slide10', () => {
    expect(naturalSort(['s10.xml', 's2.xml', 's1.xml'])).toEqual(['s1.xml', 's2.xml', 's10.xml']);
  });
});

describe('extractors — docx/pptx/xlsx/hwpx (zip+xml)', () => {
  it('docx 본문을 읽는다', () => {
    const zip = zipSync({
      'word/document.xml': u8('<w:document><w:body><w:p><w:r><w:t>회의 결론</w:t></w:r></w:p></w:body></w:document>'),
      '[Content_Types].xml': u8('<Types/>'),
    });
    const out = docxText(zip);
    expect(out).toEqual({ ok: true, doc: { text: '회의 결론' } });
  });

  it('docx가 아닌 zip은 이유와 함께 건너뛴다', () => {
    const zip = zipSync({ 'hello.txt': u8('hi') });
    expect(docxText(zip)).toEqual({ skip: true, reason: 'notDocx' });
  });

  it('깨진 zip은 throw하지 않고 건너뛴다', () => {
    expect(docxText(u8('not a zip at all'))).toEqual({ skip: true, reason: 'damagedZip' });
  });

  it('pptx는 슬라이드별로 묶는다(순서 유지)', () => {
    const zip = zipSync({
      'ppt/slides/slide1.xml': u8('<p:sld><a:p><a:r><a:t>표지</a:t></a:r></a:p></p:sld>'),
      'ppt/slides/slide2.xml': u8('<p:sld><a:p><a:r><a:t>본론</a:t></a:r></a:p></p:sld>'),
    });
    const out = pptxText(zip);
    expect(out).toEqual({ ok: true, doc: { text: '## Slide 1\n표지\n\n## Slide 2\n본론' } });
  });

  it('xlsx는 공유문자열을 풀어 표로 만든다', () => {
    const shared = '<sst><si><t>이름</t></si><si><t>홍길동</t></si></sst>';
    const sheet =
      '<worksheet><sheetData>' +
      '<row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>10</v></c></row>' +
      '<row><c r="A2" t="s"><v>1</v></c><c r="B2"><v>20</v></c></row>' +
      '</sheetData></worksheet>';
    const zip = zipSync({
      'xl/sharedStrings.xml': u8(shared),
      'xl/workbook.xml': u8('<workbook><sheets><sheet name="명단"/></sheets></workbook>'),
      'xl/worksheets/sheet1.xml': u8(sheet),
    });
    const out = xlsxText(zip);
    expect(out).toEqual({ ok: true, doc: { text: '## 명단\n이름\t10\n홍길동\t20' } });
  });

  it('parseSharedStrings/parseSheet 단위 동작', () => {
    expect(parseSharedStrings('<sst><si><t>a</t></si><si><t>b</t></si></sst>')).toEqual(['a', 'b']);
    expect(parseSheet('<row><c t="inlineStr"><is><t>인라인</t></is></c></row>', [])).toBe('인라인');
  });

  it('hwpx(신형 한글)를 읽는다', () => {
    const zip = zipSync({
      'Contents/section0.xml': u8('<hs:sec><hp:p><hp:run><hp:t>한글 문서 본문</hp:t></hp:run></hp:p></hs:sec>'),
    });
    expect(hwpxText(zip)).toEqual({ ok: true, doc: { text: '한글 문서 본문' } });
  });

  it('내용이 비면 noText로 건너뛴다', () => {
    const zip = zipSync({ 'word/document.xml': u8('<w:document><w:body/></w:document>') });
    expect(docxText(zip)).toEqual({ skip: true, reason: 'noText' });
  });
});
