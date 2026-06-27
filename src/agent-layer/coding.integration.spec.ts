// 코딩 루프 통합 테스트(Phase 4, Task 16).
// FakeBrain + 실 git + 실 node 게이트 명령으로 end-to-end 검증.
// coder는 stub — 타깃 repo에 실제 파일을 써서 커밋 거리를 만든다.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';
import { PathResolver } from '../pal/path-resolver';
import { ProjectStore } from '../knowledge-core/project-store';
import { TaskStore } from '../knowledge-core/task-store';
import { KeyedLock } from '../knowledge-core/keyed-lock';
import { CodingGit } from '../knowledge-core/coding-git';
import { VerificationGate } from './verification-gate';
import { ReviewerAgent } from './reviewer-agent';
import { Orchestrator } from './orchestrator';

const logger = { warn() {}, log() {} } as any;

// 순차 응답 두뇌: 인덱스 순서대로 다른 JSON을 돌려준다. 마지막 응답은 이후에도 반복.
function seqBrain(responses: string[]) {
  let i = 0;
  return {
    complete: async () => ({
      text: responses[Math.min(i++, responses.length - 1)],
      costUsd: 0,
      isError: false,
    }),
  };
}

// 고정 응답 두뇌: 항상 같은 JSON.
function fixedBrain(text: string) {
  return {
    complete: async () => ({ text, costUsd: 0, isError: false }),
  };
}

describe('코딩 루프 통합(FakeBrain + 실 git)', () => {
  let dataDir: string;
  let targetRepo: string;

  beforeEach(async () => {
    // 격리 임시 디렉토리 — 실 runtime/을 오염하지 않는다.
    dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'engram-int-data-'));
    targetRepo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'engram-int-target-'));

    // 타깃 repo 초기화(git init + 초기 커밋 없으면 ensureBranch가 HEAD 없다고 실패).
    const g = simpleGit(targetRepo);
    await g.init();
    await g.addConfig('user.name', 'T');
    await g.addConfig('user.email', 't@t');
    await fs.promises.writeFile(path.join(targetRepo, 'README.md'), 'init');
    await g.add('.');
    await g.commit('init');
  });

  afterEach(async () => {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
    await fs.promises.rm(targetRepo, { recursive: true, force: true });
  });

  it(
    'proposeProject→approve→codeRun→격리 브랜치 커밋→SUCCESS→세션 삭제',
    async () => {
      // 실 컴포넌트: ProjectStore, TaskStore, CodingGit, VerificationGate.
      const paths = new PathResolver(dataDir);
      const projects = new ProjectStore(paths.getProjectsDir());
      const tasks = new TaskStore(paths.getStateDir(), new KeyedLock());
      const codingGit = new CodingGit();
      const gate = new VerificationGate();

      // ReviewerAgent: 별도 두뇌 인스턴스(JUDGE_BRAIN). fixedBrain으로 항상 승인.
      const reviewer = new ReviewerAgent(
        fixedBrain('{"approved":true,"extraTickets":[]}') as any,
      );

      // coder stub: 타깃에 파일을 써서 commitAll이 커밋할 변경을 만든다.
      // 실 CodingSpecialist는 claude를 스폰하므로 통합 테스트에서 사용 불가.
      let fileIndex = 0;
      const coder = {
        work: async () => {
          await fs.promises.writeFile(
            path.join(targetRepo, `f${fileIndex++}.txt`),
            'stub-code',
          );
          return '작업함';
        },
      };

      // Semaphore stub: 동시성 제한 없이 즉시 실행.
      const sem = { run: (f: any) => f() };

      // codeBrain — 순차 응답:
      //   1번째 호출(proposeProject): acceptanceCriteria + gate JSON.
      //   2번째 호출(decompose/codeRun): tickets JSON.
      // 게이트 test 명령은 `node -e "process.exit(0)"` — Windows node.exe로 즉시 통과.
      const codeBrain = seqBrain([
        '{"acceptanceCriteria":["완성"],"gate":{"test":"node -e \\"process.exit(0)\\"","build":"","typecheck":""}}',
        '{"tickets":[{"area":".","instruction":"파일 추가"}]}',
      ]);

      // fence stub: proposeProject가 assertWritable을 호출하지만 테스트에선 제한 없음.
      // codingFlags는 Orchestrator가 직접 부르지 않음(CodingSpecialist.work 내부용) — 빈 배열 반환.
      const fence = { assertWritable: () => {}, codingFlags: () => [] };

      // Orchestrator 15-인자 조립(생성자 선언 순서대로):
      // reader, conversations, logger, ingester, tasks, specialist, synthesizer,
      // sem, projects, gate, codingGit, coder, reviewer, codeBrain, fence
      const o = new Orchestrator(
        {} as any,        // reader
        {} as any,        // conversations
        logger,           // logger
        {} as any,        // ingester
        tasks as any,     // tasks (TaskStore)
        undefined,        // specialist (미사용)
        undefined,        // synthesizer (미사용)
        sem as any,       // sem (Semaphore)
        projects as any,  // projects (ProjectStore)
        gate as any,      // gate (VerificationGate)
        codingGit as any, // codingGit (CodingGit)
        coder as any,     // coder (stub)
        reviewer as any,  // reviewer (ReviewerAgent)
        codeBrain as any, // codeBrain (BrainProvider)
        fence as any,     // fence (PermissionFence)
      );

      // 1단계: 완성조건·게이트 추정 → approved=false로 저장.
      const cfg = await o.proposeProject(targetRepo, '뭔가 추가');
      expect(cfg.approved).toBe(false);
      expect(cfg.acceptanceCriteria).toContain('완성');

      // 2단계: 사람 승인 대리.
      await o.approveProject(cfg.id);
      const approved = await projects.get(cfg.id);
      expect(approved?.approved).toBe(true);

      // 3단계: 코딩 루프 — 격리 브랜치 생성 → coder stub 파일 쓰기 → 게이트 통과 →
      //   브랜치 커밋 → 리뷰어 승인 → SUCCESS → 세션 레코드 삭제.
      const r = await o.codeRun(cfg.id, { maxRounds: 5 });

      // SUCCESS 단언.
      expect(r.status).toBe('SUCCESS');

      // 격리 브랜치가 현재 체크아웃 상태여야 한다.
      expect(await codingGit.currentBranch(targetRepo)).toBe(cfg.branch);

      // 타깃 repo에 'engram:' 으로 시작하는 커밋이 있어야 한다.
      const log = await simpleGit(targetRepo).log();
      expect(log.all.some((c) => c.message.startsWith('engram:'))).toBe(true);

      // 완료 후 세션 레코드가 삭제됐는지(remove 호출 = null 반환).
      expect(await tasks.get(r.sessionId)).toBeNull();
    },
    20000, // 실 git + node 명령 실행 — 기본 5s로 부족할 수 있음.
  );
});
