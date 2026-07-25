import {
  createPullRequest,
  isAlreadyExists,
  isDefaultBranch,
  parseDefaultBranch,
  parsePrUrl,
  RunResult,
  Runner,
  tailLines,
} from './git-pr';

describe('parsePrUrl', () => {
  it('gh 성공 출력에서 PR URL을 뽑는다', () => {
    expect(parsePrUrl('https://github.com/22noH/Engram/pull/42\n')).toBe(
      'https://github.com/22noH/Engram/pull/42',
    );
  });

  it('"이미 존재" 안내 문장 안의 URL도 뽑는다', () => {
    const err =
      'a pull request for branch "feat/x" into branch "main" already exists: https://github.com/o/r/pull/7';
    expect(parsePrUrl(err)).toBe('https://github.com/o/r/pull/7');
  });

  it('GitHub Enterprise 호스트도 인식한다', () => {
    expect(parsePrUrl('https://git.corp.example.com/o/r/pull/3')).toBe(
      'https://git.corp.example.com/o/r/pull/3',
    );
  });

  it('URL이 없으면 null', () => {
    expect(parsePrUrl('something went wrong')).toBeNull();
    // @ts-expect-error 방어: 비문자열 입력
    expect(parsePrUrl(undefined)).toBeNull();
  });
});

describe('parseDefaultBranch / isDefaultBranch', () => {
  it('origin/HEAD 출력에서 기본 브랜치 이름을 뽑는다', () => {
    expect(parseDefaultBranch('origin/main\n')).toBe('main');
    expect(parseDefaultBranch('refs/remotes/origin/develop')).toBe('develop');
    expect(parseDefaultBranch('')).toBeNull();
  });

  it('원격 기본 브랜치를 알면 그 이름과만 비교한다', () => {
    expect(isDefaultBranch('develop', 'develop')).toBe(true);
    expect(isDefaultBranch('main', 'develop')).toBe(false); // 원격 기본이 develop이면 main은 기본이 아니다
  });

  it('원격 기본 브랜치를 모르면 관례 이름으로 폴백한다', () => {
    expect(isDefaultBranch('main', null)).toBe(true);
    expect(isDefaultBranch('master', null)).toBe(true);
    expect(isDefaultBranch('feat/voice', null)).toBe(false);
  });
});

describe('isAlreadyExists / tailLines', () => {
  it('already exists 문구를 감지한다', () => {
    expect(isAlreadyExists('... already exists: https://x/pull/1')).toBe(true);
    expect(isAlreadyExists('permission denied')).toBe(false);
  });

  it('에러 꼬리 몇 줄만 남긴다', () => {
    expect(tailLines('a\nb\nc\nd\ne\nf', 2)).toBe('e / f');
    expect(tailLines('   \n\n')).toBe('');
  });
});

// ---- createPullRequest: 가짜 Runner로 각 실패 케이스 재현 ----

const OK = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const FAIL = (stderr = 'boom'): RunResult => ({ code: 1, stdout: '', stderr });
const MISSING = (): RunResult => ({ code: -1, stdout: '', stderr: '', spawnError: true });

/** cmd+첫 인자들로 키를 만들어 응답을 고르는 가짜 러너. 호출 기록도 남긴다. */
function fakeRunner(map: Record<string, RunResult>): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = async (cmd: string, args: string[]): Promise<RunResult> => {
    calls.push([cmd, ...args]);
    const key = Object.keys(map).find((k) => [cmd, ...args].join(' ').startsWith(k));
    return key ? map[key] : OK();
  };
  return Object.assign(fn, { calls });
}

const HAPPY: Record<string, RunResult> = {
  'git rev-parse --abbrev-ref HEAD': OK('feat/voice\n'),
  'git rev-parse --abbrev-ref origin/HEAD': OK('origin/main\n'),
  'git remote get-url origin': OK('git@github.com:o/r.git\n'),
  'gh auth status': OK('Logged in'),
  'git push': OK(''),
  'gh pr create': OK('https://github.com/o/r/pull/9\n'),
};

describe('createPullRequest', () => {
  it('정상 흐름: push 후 PR URL을 돌려준다', async () => {
    const r = fakeRunner(HAPPY);
    const res = await createPullRequest('/repo', r);
    expect(res).toEqual({ ok: true, url: 'https://github.com/o/r/pull/9', alreadyExisted: false });
    expect(r.calls).toContainEqual(['git', 'push', '-u', 'origin', 'feat/voice']);
  });

  it('기본 브랜치에서는 push조차 하지 않고 거부한다', async () => {
    const r = fakeRunner({ ...HAPPY, 'git rev-parse --abbrev-ref HEAD': OK('main\n') });
    const res = await createPullRequest('/repo', r);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('on-default-branch');
    expect(res.message).toContain('main');
    expect(r.calls.some((c) => c[1] === 'push')).toBe(false); // 원격을 전혀 건드리지 않음
  });

  it('origin/HEAD를 못 읽어도 main이면 관례 폴백으로 거부한다', async () => {
    const r = fakeRunner({
      ...HAPPY,
      'git rev-parse --abbrev-ref HEAD': OK('master\n'),
      'git rev-parse --abbrev-ref origin/HEAD': FAIL('fatal: ambiguous argument'),
    });
    const res = await createPullRequest('/repo', r);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('on-default-branch');
  });

  it('gh 미설치와 미인증을 구분한다', async () => {
    const missing = await createPullRequest('/repo', fakeRunner({ ...HAPPY, 'gh auth status': MISSING() }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toBe('gh-missing');
      expect(missing.message).toContain('cli.github.com');
    }

    const unauth = await createPullRequest('/repo', fakeRunner({ ...HAPPY, 'gh auth status': FAIL('not logged in') }));
    expect(unauth.ok).toBe(false);
    if (!unauth.ok) {
      expect(unauth.reason).toBe('gh-unauthenticated');
      expect(unauth.message).toContain('gh auth login');
    }
  });

  it('origin 리모트가 없으면 no-remote', async () => {
    const r = fakeRunner({ ...HAPPY, 'git remote get-url origin': FAIL('error: No such remote') });
    const res = await createPullRequest('/repo', r);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-remote');
    expect(r.calls.some((c) => c[1] === 'push')).toBe(false);
  });

  it('git 저장소가 아니면 not-repo, git 자체가 없으면 error', async () => {
    const notRepo = await createPullRequest(
      '/repo',
      fakeRunner({ 'git rev-parse --abbrev-ref HEAD': FAIL('not a git repository') }),
    );
    expect(notRepo.ok).toBe(false);
    if (!notRepo.ok) expect(notRepo.reason).toBe('not-repo');

    const noGit = await createPullRequest('/repo', fakeRunner({ 'git rev-parse --abbrev-ref HEAD': MISSING() }));
    expect(noGit.ok).toBe(false);
    if (!noGit.ok) expect(noGit.reason).toBe('error');
  });

  it('detached HEAD는 PR을 만들지 않는다', async () => {
    const r = fakeRunner({ ...HAPPY, 'git rev-parse --abbrev-ref HEAD': OK('HEAD\n') });
    const res = await createPullRequest('/repo', r);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('detached');
  });

  it('push 실패는 push-failed로, 원인 문구를 함께 돌려준다', async () => {
    const r = fakeRunner({ ...HAPPY, 'git push': FAIL('remote: Permission to o/r.git denied') });
    const res = await createPullRequest('/repo', r);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('push-failed');
      expect(res.message).toContain('Permission');
    }
  });

  it('이미 PR이 있으면 그 URL을 성공으로 돌려준다(alreadyExisted)', async () => {
    const r = fakeRunner({
      ...HAPPY,
      'gh pr create': {
        code: 1,
        stdout: '',
        stderr: 'a pull request for branch "feat/voice" already exists: https://github.com/o/r/pull/5',
      },
    });
    const res = await createPullRequest('/repo', r);
    expect(res).toEqual({ ok: true, url: 'https://github.com/o/r/pull/5', alreadyExisted: true });
  });

  it('gh pr create가 다른 이유로 실패하면 pr-failed', async () => {
    const r = fakeRunner({ ...HAPPY, 'gh pr create': FAIL('GraphQL: rate limited') });
    const res = await createPullRequest('/repo', r);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('pr-failed');
      expect(res.message).toContain('rate limited');
    }
  });

  it('repoPath가 없으면 never-throw로 error', async () => {
    // @ts-expect-error 의도적으로 잘못된 타입 전달
    expect((await createPullRequest(undefined)).ok).toBe(false);
    expect((await createPullRequest('')).ok).toBe(false);
  });

  it('러너가 throw해도 결과형으로 흡수한다(never-throw)', async () => {
    const res = await createPullRequest('/repo', () => Promise.reject(new Error('kaboom')));
    expect(res).toEqual({ ok: false, reason: 'error', message: 'kaboom' });
  });
});
