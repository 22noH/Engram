import { execFile } from 'child_process';

// 코드 채널 상단 줄의 [PR 생성](승인된 B안). git-diff.ts는 "절대 쓰지 않는다"는 불변식을 지키는
// 읽기 전용 모듈이라, 원격을 건드리는 이 동작은 일부러 별도 파일로 분리했다.
//
// ⚠️ 이 모듈은 되돌리기 어려운 외부 동작(push + PR 생성)을 "실행"만 한다. 사용자 확인(정말 만들까요?)
//    UI는 렌더러 담당이다 — 여기엔 확인 절차가 없으니 호출부가 반드시 먼저 물어봐야 한다.
//
// 테스트 가능성: 모든 외부 명령은 주입된 Runner로만 실행한다(레포 관례 — pty-manager의 SpawnFactory
// 주입과 동일한 결). 유닛테스트는 가짜 Runner로 gh 미설치·미인증·리모트 없음 등을 전부 재현한다.

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** 프로세스를 아예 못 띄웠을 때(ENOENT 등) true — "명령 없음"과 "명령이 실패함"의 구분점. */
  spawnError?: boolean;
}

export type Runner = (cmd: string, args: string[], cwd: string) => Promise<RunResult>;

export type PrFailReason =
  | 'not-repo'
  | 'detached'
  | 'on-default-branch'
  | 'no-remote'
  | 'gh-missing'
  | 'gh-unauthenticated'
  | 'push-failed'
  | 'pr-failed'
  | 'error';

export type CreatePrResult =
  | { ok: true; url: string; alreadyExisted: boolean }
  | { ok: false; reason: PrFailReason; message: string };

// 기본 Runner: execFile(셸 미경유 — 인자 인젝션 여지 없음). 비0 종료는 예외가 아니라 결과로 돌린다.
export const defaultRunner: Runner = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      const spawnError = e != null && (e.code === 'ENOENT' || e.code === 'EACCES');
      const code = typeof e?.code === 'number' ? e.code : e ? 1 : 0;
      resolve({ code: spawnError ? -1 : code, stdout: String(stdout), stderr: String(stderr), spawnError });
    });
  });

// ---- 순수 파서(유닛테스트 대상) ----

// gh는 성공 시 PR URL 한 줄을 stdout에 찍고, 이미 있으면 stderr에
// "a pull request for branch ... already exists: <url>"을 찍는다. 둘 다 여기서 URL만 뽑는다.
// (호스트를 github.com으로 못 박지 않는다 — GitHub Enterprise도 같은 /pull/<번호> 꼴이다.)
export function parsePrUrl(text: string): string | null {
  const m = String(text ?? '').match(/https?:\/\/\S+?\/pull\/\d+/);
  return m ? m[0] : null;
}

// gh가 "이미 PR이 있다"고 알려준 경우인지. 이건 실패가 아니라 사용자가 원한 결과(그 PR로 보내면 됨).
export function isAlreadyExists(text: string): boolean {
  return /already exists/i.test(String(text ?? ''));
}

// `git rev-parse --abbrev-ref origin/HEAD` → "origin/main". 원격 HEAD가 설정 안 된 레포도 흔해서
// (clone 방식·오래된 레포) 실패하면 null → 호출부가 이름 기반 폴백으로 넘어간다.
export function parseDefaultBranch(out: string): string | null {
  const line = String(out ?? '').trim().split(/\r?\n/)[0]?.trim();
  if (!line) return null;
  const m = line.match(/^(?:refs\/remotes\/)?origin\/(.+)$/);
  return m ? m[1] : null;
}

// 원격 HEAD를 못 읽었을 때의 폴백: 관례적 기본 브랜치 이름이면 기본 브랜치로 간주한다.
// (과탐지 방향으로 둔다 — "main에서 PR 만들려다 거부"가 "main을 푸시해버림"보다 훨씬 안전하다.)
const CONVENTIONAL_DEFAULTS = ['main', 'master', 'trunk'];
export function isDefaultBranch(branch: string, remoteDefault: string | null): boolean {
  if (remoteDefault) return branch === remoteDefault;
  return CONVENTIONAL_DEFAULTS.includes(branch);
}

// 에러 문자열을 너무 길게 UI로 흘리지 않게 꼬리만(마지막 몇 줄) 남긴다.
export function tailLines(text: string, max = 4): string {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-max)
    .join(' / ');
}

// 브랜치 이름이 옵션으로 해석될 여지(-로 시작)나 NUL을 담지 않는지 — git-diff.ts의 isSafeFileArg와 같은 결.
function isSafeBranch(b: string): boolean {
  return typeof b === 'string' && b.length > 0 && !b.startsWith('-') && !b.includes('\0');
}

// ---- 실행 ----

/**
 * 현재 브랜치를 origin에 push하고 `gh pr create --fill`로 PR을 만든다. never-throw.
 *
 * 실패는 전부 reason으로 구분해 돌린다(사용자가 무엇을 해야 하는지 알 수 있게):
 *  - gh-missing         : gh CLI 미설치 → 설치 안내
 *  - gh-unauthenticated : gh는 있는데 로그인 안 됨 → `gh auth login` 안내
 *  - no-remote          : origin 리모트 없음 → 원격 저장소 연결 안내
 *  - on-default-branch  : 기본 브랜치에서의 PR은 거부(먼저 브랜치를 만들라는 안내)
 */
export async function createPullRequest(
  repoPath: string,
  runner: Runner = defaultRunner,
): Promise<CreatePrResult> {
  if (typeof repoPath !== 'string' || repoPath.length === 0) {
    return { ok: false, reason: 'error', message: 'No repository folder is selected.' };
  }
  try {
    // 1) 현재 브랜치. 레포가 아니거나 git이 없으면 여기서 걸러진다.
    const head = await runner('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
    if (head.spawnError) {
      return { ok: false, reason: 'error', message: 'Git is not installed, or not on PATH.' };
    }
    if (head.code !== 0) {
      return { ok: false, reason: 'not-repo', message: 'This folder is not a Git repository.' };
    }
    const branch = head.stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
    if (!isSafeBranch(branch)) {
      return { ok: false, reason: 'error', message: 'Could not read the current branch name.' };
    }
    if (branch === 'HEAD') {
      return {
        ok: false,
        reason: 'detached',
        message: 'HEAD is detached. Check out a branch before creating a pull request.',
      };
    }

    // 2) 기본 브랜치에서는 거부(PR은 브랜치 → 기본 브랜치로 여는 것).
    const remoteHead = await runner('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], repoPath);
    const remoteDefault = remoteHead.code === 0 ? parseDefaultBranch(remoteHead.stdout) : null;
    if (isDefaultBranch(branch, remoteDefault)) {
      return {
        ok: false,
        reason: 'on-default-branch',
        message: `You are on the default branch (${branch}). Create a feature branch first, then open a pull request.`,
      };
    }

    // 3) origin 리모트 존재 확인.
    const remote = await runner('git', ['remote', 'get-url', 'origin'], repoPath);
    if (remote.spawnError || remote.code !== 0 || !remote.stdout.trim()) {
      return {
        ok: false,
        reason: 'no-remote',
        message: 'No "origin" remote is configured. Connect this repository to GitHub first.',
      };
    }

    // 4) gh 설치·인증 확인 — 두 실패를 반드시 구분해서 안내한다(설치 vs 로그인은 할 일이 전혀 다름).
    const auth = await runner('gh', ['auth', 'status'], repoPath);
    if (auth.spawnError) {
      return {
        ok: false,
        reason: 'gh-missing',
        message: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com, then try again.',
      };
    }
    if (auth.code !== 0) {
      return {
        ok: false,
        reason: 'gh-unauthenticated',
        message: 'GitHub CLI is not signed in. Run "gh auth login" in a terminal, then try again.',
      };
    }

    // 5) push. -u로 업스트림까지 세팅(다음 push부터는 인자 없이 되게).
    const push = await runner('git', ['push', '-u', 'origin', branch], repoPath);
    if (push.spawnError || push.code !== 0) {
      return {
        ok: false,
        reason: 'push-failed',
        message: `Push failed: ${tailLines(push.stderr || push.stdout) || 'unknown error'}`,
      };
    }

    // 6) PR 생성. --fill = 커밋 메시지로 제목·본문 자동 채움(사용자 입력 없이 한 번에).
    const pr = await runner('gh', ['pr', 'create', '--fill', '--head', branch], repoPath);
    const url = parsePrUrl(pr.stdout) ?? parsePrUrl(pr.stderr);
    if (pr.code === 0 && url) return { ok: true, url, alreadyExisted: false };
    // 이미 열린 PR이 있으면 gh가 비0으로 끝나지만 URL을 함께 준다 — 사용자 관점에선 성공.
    if (url && isAlreadyExists(pr.stderr)) return { ok: true, url, alreadyExisted: true };
    if (pr.code === 0 && !url) {
      return { ok: false, reason: 'pr-failed', message: 'GitHub CLI did not return a pull request URL.' };
    }
    return {
      ok: false,
      reason: 'pr-failed',
      message: `Could not create the pull request: ${tailLines(pr.stderr || pr.stdout) || 'unknown error'}`,
    };
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
