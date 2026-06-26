import 'reflect-metadata';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as readline from 'readline';
import { PathResolver } from '../src/pal/path-resolver';
import { WikiGit } from '../src/knowledge-core/wiki/wiki-git';
import { KeyedLock } from '../src/knowledge-core/keyed-lock';
import { TransformersEmbedder } from '../src/knowledge-core/rag/transformers-embedder';
import { CachingEmbedder } from '../src/knowledge-core/rag/caching-embedder';
import { RagStore } from '../src/knowledge-core/rag/rag-store';
import { WikiEngine } from '../src/knowledge-core/wiki/wiki-engine';

// KnowledgeCore 대화형 데모 — 직접 페이지를 넣고 검색어를 쳐서 실시간으로 결과를 본다.
// 실제 bge-m3 임베더로 동작. 임시 디렉토리를 써서 runtime/는 건드리지 않는다.

const SEED = [
  { slug: 'espresso', title: '에스프레소 추출 가이드', category: 'coffee',
    body: '곱게 간 원두에 9바 압력으로 뜨거운 물을 통과시켜 25~30초 동안 진하게 뽑아낸다. 표면에 황금빛 크레마가 올라오면 잘 된 것이다.' },
  { slug: 'ts-generics', title: 'TypeScript 제네릭', category: 'programming',
    body: '함수나 클래스가 구체 타입에 묶이지 않도록 <T> 같은 매개변수로 추상화한다. 같은 로직을 여러 자료형에 재사용하면서도 컴파일 시점 안전성을 지킨다.' },
  { slug: 'cats', title: '고양이 행동 이해하기', category: 'animals',
    body: '발로 꾹꾹 누르는 행동은 어린 시절의 안정감에서 비롯된다. 그르렁 소리는 만족을 뜻하기도 하고, 영역을 표시하려 가구에 몸을 비비기도 한다.' },
  { slug: 'bitcoin', title: '비트코인 반감기', category: 'finance',
    body: '약 21만 블록마다 채굴 보상이 절반으로 줄어든다. 신규 발행량이 감소해 희소성이 커지는 구조다.' },
  { slug: 'photosynthesis', title: '광합성의 원리', category: 'biology',
    body: '엽록체가 빛 에너지를 흡수해 이산화탄소와 물을 포도당으로 바꾼다. 부산물로 산소를 내보낸다.' },
  { slug: 'rome', title: '로마 제국의 흥망', category: 'history',
    body: '공화정에서 제정으로 넘어가며 지중해 전역을 지배했으나, 군사적 과부하와 내분으로 서서히 분열되었다.' },
  { slug: 'sleep', title: '잠과 회복', category: 'health',
    body: '깊은 수면 동안 뇌는 노폐물을 씻어내고 기억을 정리한다. 충분히 자지 못하면 집중력과 면역이 떨어진다.' },
];

const HELP = `
명령:
  search <질의>   의미 검색 (또는 그냥 질의만 입력해도 검색)
  add <slug> | <제목> | <본문>   페이지 추가 + 색인
  unpublish <slug>   색인에서 제거
  list   페이지 목록
  help   이 도움말
  quit   종료
`;

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-demo-'));
  const paths = new PathResolver(dir);
  const git = new WikiGit(paths);
  const rag = new RagStore(paths, new CachingEmbedder(new TransformersEmbedder()));
  const wiki = new WikiEngine(paths, git, new KeyedLock(), rag);

  await git.ensureRepo();
  await rag.init();

  process.stdout.write('모델 로딩 + 시드 페이지 색인 중(첫 실행은 수십 초)…\n');
  for (const p of SEED) await wiki.createPage({ ...p, status: 'published' });
  process.stdout.write(`준비 완료. 시드 ${SEED.length}개 색인됨.\n${HELP}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'engram> ' });
  rl.prompt();

  async function doSearch(q: string) {
    console.log(`🔎 "${q}"`);
    const hits = await rag.search(q, 5);
    if (hits.length === 0) { console.log('  (결과 없음 — 먼저 페이지를 add 하세요)'); return; }
    hits.forEach((h, i) =>
      console.log(`  ${i + 1}. score=${h.score.toFixed(4)}  [${h.slug}] ${h.title}  «${h.text.slice(0, 40)}…»`),
    );
  }

  // 입력을 한 줄씩 직렬 처리(처리 중엔 pause). closing 가드로 close 후 prompt 호출 방지.
  let closing = false;
  rl.on('line', async (line) => {
    rl.pause();
    const input = line.trim();
    try {
      if (!input) { /* no-op */ }
      else if (input === 'help') console.log(HELP);
      else if (input === 'quit' || input === 'exit') { rl.close(); return; }
      else if (input === 'list') {
        const pages = await wiki.listPages();
        pages.forEach((p) => console.log(`  [${p.slug}] ${p.frontmatter.title} (${p.frontmatter.status})`));
      } else if (input.startsWith('add ')) {
        const [slug, title, body] = input.slice(4).split('|').map((s) => s.trim());
        if (!slug || !title || !body) console.log('  형식: add <slug> | <제목> | <본문>');
        else { await wiki.createPage({ slug, title, category: 'misc', body, status: 'published' }); console.log(`  ✔ 추가·색인됨: [${slug}] ${title}`); }
      } else if (input.startsWith('unpublish ')) {
        const slug = input.slice(10).trim();
        await wiki.unpublishPage(slug);
        console.log(`  ✔ 색인에서 제거: ${slug}`);
      } else {
        await doSearch(input.startsWith('search ') ? input.slice(7).trim() : input);
      }
    } catch (e) {
      console.log(`  오류: ${(e as Error).message}`);
    }
    if (!closing) { rl.resume(); rl.prompt(); }
  });

  rl.on('close', async () => {
    closing = true;
    // Windows에선 LanceDB/git 핸들이 늦게 닫혀 rmdir가 EBUSY일 수 있다 — 정리는 best-effort.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    process.stdout.write('종료.\n');
    process.exit(0);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
