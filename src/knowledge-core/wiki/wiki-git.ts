import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import simpleGit, { SimpleGit } from 'simple-git';
import { PathResolver } from '../../pal/path-resolver';

// 위키 데이터 디렉토리의 git 이력 관리(설계 §5.1).
// 모든 변경을 커밋으로 남겨 감사·되돌리기를 가능케 한다.
// 코드 repo와 분리된, 데이터 전용 git 저장소다(runtime/wiki).
@Injectable()
export class WikiGit {
  private readonly git: SimpleGit;

  constructor(private readonly paths: PathResolver) {
    this.git = simpleGit();
  }

  // 위키 디렉토리를 git 저장소로 보장(최초 init 시 커밋 신원도 함께 설정한다).
  async ensureRepo(): Promise<void> {
    const dir = this.paths.getWikiDir();
    await fs.mkdir(dir, { recursive: true });
    this.git.cwd(dir);
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      await this.git.init();
      // 데이터 저장소 전용 커밋 신원(코드 repo의 사용자와 분리). init 시 한 번만 설정.
      await this.git.addConfig('user.name', 'Engram');
      await this.git.addConfig('user.email', 'engram@localhost');
    }
  }

  // 위키 디렉토리의 변경을 커밋. relPath를 주면 그 경로만 스테이징(경로-스코프 — 동시 쓰기 혼입 방지,
  // 설계 §10.3/§11). relPath 미지정 시 전체(add('.')) — 하위호환. 스테이징된 변경이 없으면 커밋 생략.
  async commitAll(message: string, relPath?: string): Promise<void> {
    this.git.cwd(this.paths.getWikiDir());
    await this.git.add(relPath ?? '.');
    const status = await this.git.status();
    if (status.staged.length === 0) return; // 스테이징된 변경 없음 → 빈 커밋 방지
    await this.git.commit(message);
  }

  // 최근 커밋 메시지(최신순). 테스트·감사용.
  async recentMessages(limit = 10): Promise<string[]> {
    this.git.cwd(this.paths.getWikiDir());
    const log = await this.git.log({ maxCount: limit });
    return log.all.map((c) => c.message);
  }

  // 원격 origin 보장(Phase 15b). ensureRepo 후 origin 추가(URL 바뀌면 set-url).
  async ensureRemote(url: string): Promise<void> {
    await this.ensureRepo();
    this.git.cwd(this.paths.getWikiDir());
    const remotes = await this.git.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    if (!origin) await this.git.addRemote('origin', url);
    else if (origin.refs.fetch !== url && origin.refs.push !== url) {
      await this.git.remote(['set-url', 'origin', url]);
    }
  }

  // HEAD 커밋 존재 여부(unborn 브랜치 판별).
  private async hasHead(): Promise<boolean> {
    return this.git.raw(['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false);
  }

  // 원격에서 받아 병합. 충돌 시 abort + 로컬 유지. 네트워크/원격없음은 조용히 스킵.
  async pull(branch: string): Promise<{ ok: boolean; conflict: boolean }> {
    this.git.cwd(this.paths.getWikiDir());
    try {
      await this.git.fetch('origin', branch);
    } catch {
      return { ok: false, conflict: false }; // 네트워크/원격 접근 실패 → 다음 주기
    }
    const hasRemoteRef = await this.git
      .raw(['rev-parse', '--verify', `origin/${branch}`])
      .then(() => true)
      .catch(() => false);
    if (!hasRemoteRef) return { ok: true, conflict: false }; // 원격에 아직 그 브랜치 없음
    // 로컬 커밋이 없으면 원격을 그대로 체크아웃(최초 클론 상황).
    if (!(await this.hasHead())) {
      await this.git.raw(['checkout', '-B', branch, `origin/${branch}`]);
      return { ok: true, conflict: false };
    }
    // 로컬 브랜치명을 branch로 정렬(init 기본 브랜치명 차이 흡수).
    await this.git.raw(['branch', '-M', branch]).catch(() => {});
    try {
      // --allow-unrelated-histories: 각 두뇌가 따로 git init해 커밋한 뒤 합류하면(마이그레이션)
      // 공통 조상이 없어 기본 merge가 거부된다. 다른 파일이면 자동 병합, 같은 파일이면 충돌(아래 abort).
      await this.git.raw(['merge', `origin/${branch}`, '--allow-unrelated-histories']);
    } catch {
      // merge가 non-zero exit으로 예외를 던지는 환경도 있다 — 아래 상태 확인으로 충돌 여부를 최종 판정한다.
    }
    // simple-git의 raw()는 exitCode!=0이어도 stderr가 비어 있으면(git merge 충돌 메시지는 stdout에 찍힘)
    // 예외를 던지지 않는다(확인됨). 그래서 예외 유무가 아니라 실제 충돌 파일 존재로 판정한다.
    const status = await this.git.status();
    if (status.conflicted.length > 0) {
      await this.git.raw(['merge', '--abort']).catch(() => {});
      return { ok: true, conflict: true }; // 충돌 → 로컬 유지
    }
    return { ok: true, conflict: false };
  }

  // 로컬 커밋을 원격에 push. 거부(원격 앞섬) → pull 후 1회 재시도.
  async push(branch: string): Promise<{ ok: boolean; conflict: boolean }> {
    this.git.cwd(this.paths.getWikiDir());
    if (!(await this.hasHead())) return { ok: true, conflict: false }; // 보낼 커밋 없음
    await this.git.raw(['branch', '-M', branch]).catch(() => {});
    try {
      await this.git.push('origin', branch);
      return { ok: true, conflict: false };
    } catch {
      const p = await this.pull(branch);
      if (p.conflict) return { ok: false, conflict: true };
      try {
        await this.git.push('origin', branch);
        return { ok: true, conflict: false };
      } catch {
        return { ok: false, conflict: false }; // 다음 주기 재시도
      }
    }
  }
}
