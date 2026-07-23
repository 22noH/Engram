import * as fs from 'fs/promises';
import * as path from 'path';
import simpleGit, { FileStatusResult } from 'simple-git';

// 코드 패널 diff 뷰(설계 §코드 패널). 읽기 전용 — 스테이징/커밋 등 쓰기 git 작업은 절대 하지 않는다.
// wiki-git.ts와 동일 관례: try/catch로 감싸 절대 throw하지 않고, 실패는 항상 결과 객체({ok:false,reason})로 반환.

export type DiffFileStatus = 'A' | 'M' | 'D' | 'R' | '?';

export type DiffStatusResult =
  | { ok: true; files: Array<{ path: string; status: DiffFileStatus }> }
  | { ok: false; reason: 'not-repo' | 'git-missing' | 'error' };

export type DiffFileResult = { ok: true; diff: string } | { ok: false; reason: string };

// git 바이너리 자체가 없을 때(ENOENT on the 'git' executable)와, cwd 문제 등 다른 ENOENT를 최대한 구분한다.
// 참고: Node의 spawn ENOENT는 "명령을 못 찾음"과 "cwd가 없음"을 항상 명확히 구분해 주지는 않는다(플랫폼 의존).
// 여기서는 오차를 'error'쪽으로 두어(과소분류) 오분류로 인한 오해를 줄인다 — git-missing은 확실할 때만.
function isGitMissingError(e: unknown): boolean {
  const err = e as { code?: string; path?: string; message?: string } | undefined;
  if (!err) return false;
  if (err.code === 'ENOENT' && typeof err.path === 'string' && /git(\.exe)?$/i.test(err.path)) return true;
  return typeof err.message === 'string' && /spawn git.*ENOENT/i.test(err.message);
}

// index/working_dir 두 글자 포터슬린 코드를 A/M/D/R/? 하나로 접는다.
// 우선순위: 미추적(?) > 추가(A) > 삭제(D) > 이름변경(R) > 그 외 전부 수정(M) — 조회 목적엔 이 정도 단순화로 충분.
function mapStatus(f: Pick<FileStatusResult, 'index' | 'working_dir'>): DiffFileStatus {
  const codes = `${f.index}${f.working_dir}`;
  if (codes.includes('?')) return '?';
  if (codes.includes('A')) return 'A';
  if (codes.includes('D')) return 'D';
  if (codes.includes('R')) return 'R';
  return 'M';
}

// diffStatus: `git status`(=simple-git의 status(), 내부적으로 porcelain 사용)를 그대로 재사용한다.
// `git diff --name-status`류로 스테이징/워킹트리를 따로 조회해 합치는 대신 이 한 번의 호출을 쓰는 이유:
//   1) status()가 이미 index(스테이징)와 working_dir(워킹트리) 두 글자를 함께 주므로, staged+unstaged를
//      요구사항대로 한 목록에 담기 위해 diff를 두 번 돌려 합집합을 만들 필요가 없다.
//   2) untracked 파일이 diff --name-status에는 전혀 안 잡히지만(트래킹된 파일만 비교) status()에는
//      '??' 코드로 자연스럽게 포함된다 — 요구사항의 "신규(untracked) 파일 포함"을 별도 분기 없이 만족.
//   3) wiki-git.ts가 이미 이 라이브러리를 이 패턴(status() 결과형 매핑)으로 쓰고 있어 관례상 일관적이다.
export async function diffStatus(repoPath: string): Promise<DiffStatusResult> {
  if (typeof repoPath !== 'string' || repoPath.length === 0) return { ok: false, reason: 'error' };
  try {
    const git = simpleGit(repoPath);
    let isRepo: boolean;
    try {
      isRepo = await git.checkIsRepo();
    } catch (e) {
      return { ok: false, reason: isGitMissingError(e) ? 'git-missing' : 'error' };
    }
    if (!isRepo) return { ok: false, reason: 'not-repo' };
    const status = await git.status();
    const files = status.files.map((f) => ({ path: f.path, status: mapStatus(f) }));
    return { ok: true, files };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// file 인자 안전성: diffStatus가 돌려준 경로만 신뢰한다는 전제 하에, 이 계층에서는 방어적으로
// "-"로 시작하는 문자열(옵션 인젝션 시도로 오인될 수 있는 값)과 NUL 바이트를 최소한으로 걸러낸다.
// 실제 git 호출에는 항상 `--` 구분자를 붙여 인자를 옵션으로 해석할 여지를 원천 차단한다(이중 방어).
function isSafeFileArg(file: unknown): file is string {
  return typeof file === 'string' && file.length > 0 && !file.startsWith('-') && !file.includes('\0');
}

// 미추적(untracked) 파일의 새 내용을 unified diff 형식으로 합성한다.
// 대안이었던 `git diff --no-index -- /dev/null <file>`을 쓰지 않은 이유:
//   --no-index는 git diff의 --exit-code 의미를 암묵 적용해 "차이가 있으면" 종료코드 1을 낸다.
//   simple-git의 raw()는 비0 종료코드를 곧바로 예외로 던지므로(diff가 있다=정상인데도 실패로 취급),
//   그 예외에서 stdout(진짜 diff 본문)을 안전하게 복구한다는 보장이 없다 — 라이브러리 내부 구현에
//   기대는 취약한 코드가 된다. 반면 새 파일 내용을 직접 읽어 +로만 구성된 diff를 만드는 쪽은
//   git 프로세스의 종료코드 의미론에 전혀 기대지 않고, 크로스플랫폼으로도 동일하게 동작한다.
async function untrackedDiff(repoPath: string, file: string): Promise<DiffFileResult> {
  let content: string;
  try {
    content = await fs.readFile(path.join(repoPath, file), 'utf8');
  } catch {
    return { ok: false, reason: 'error' };
  }
  let lines = content.split(/\r\n|\n/);
  // 파일이 개행으로 끝나면 split의 마지막 원소가 빈 문자열로 남는다 — 줄 수 계산에서 제외.
  if (content.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  const header =
    `diff --git a/${file} b/${file}\n` +
    `new file mode 100644\n` +
    `--- /dev/null\n` +
    `+++ b/${file}\n` +
    `@@ -0,0 +1,${lines.length} @@\n`;
  const body = lines.map((l) => `+${l}`).join('\n');
  return { ok: true, diff: header + body + (lines.length > 0 ? '\n' : '') };
}

// diffFile: 트래킹된 파일은 `git diff HEAD -- <file>`(스테이징+워킹트리 변경을 HEAD 대비 한 번에 보여줌 —
// diffStatus가 두 상태를 합쳐 보여주는 것과 일관된 관점), 미추적 파일은 위 untrackedDiff로 분기.
export async function diffFile(repoPath: string, file: string): Promise<DiffFileResult> {
  if (typeof repoPath !== 'string' || repoPath.length === 0) return { ok: false, reason: 'error' };
  if (!isSafeFileArg(file)) return { ok: false, reason: 'error' };
  try {
    const git = simpleGit(repoPath);
    let isRepo: boolean;
    try {
      isRepo = await git.checkIsRepo();
    } catch (e) {
      return { ok: false, reason: isGitMissingError(e) ? 'git-missing' : 'error' };
    }
    if (!isRepo) return { ok: false, reason: 'not-repo' };
    const status = await git.status();
    const entry = status.files.find((f) => f.path === file);
    if (entry && mapStatus(entry) === '?') return untrackedDiff(repoPath, file);
    const diff = await git.raw(['diff', 'HEAD', '--', file]);
    return { ok: true, diff };
  } catch {
    return { ok: false, reason: 'error' };
  }
}
