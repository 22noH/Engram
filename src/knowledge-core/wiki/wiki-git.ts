import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import { PathResolver } from '../../pal/path-resolver';
import { parsePage, serializePage } from './page-serializer';
import { reconcileFrontmatter, unionBodies } from './page-merge';

// 위키 데이터 디렉토리의 git 이력 관리(설계 §5.1).
// 모든 변경을 커밋으로 남겨 감사·되돌리기를 가능케 한다.
// 코드 repo와 분리된, 데이터 전용 git 저장소다(runtime/wiki).
@Injectable()
export class WikiGit {
  private readonly git: SimpleGit;

  constructor(private readonly paths: PathResolver) {
    this.git = simpleGit();
  }

  private bodyMerger?: (oursBody: string, theirsBody: string) => Promise<string | null>;
  // 진짜 본문 겹침일 때 쓸 두뇌 병합기 주입(옵셔널 — 미주입 시 union 폴백).
  setBodyMerger(fn: (oursBody: string, theirsBody: string) => Promise<string | null>): void {
    this.bodyMerger = fn;
  }

  // 저장소 전역 직렬화: commitAll/pull/push/ensureRemote가 서로·동시 쓰기와 인터리브하지 않게(손상 차단).
  private chain: Promise<unknown> = Promise.resolve();
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn); // 이전 결과와 무관하게 다음 실행
    this.chain = next.catch(() => {});    // 체인은 reject 전파 안 함
    return next;                          // 호출자는 실제 결과/예외를 받음
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
    return this.serialize(async () => {
      this.git.cwd(this.paths.getWikiDir());
      await this.git.add(relPath ?? '.');
      const status = await this.git.status();
      if (status.staged.length === 0) return; // 스테이징된 변경 없음 → 빈 커밋 방지
      await this.git.commit(message);
    });
  }

  // 최근 커밋 메시지(최신순). 테스트·감사용.
  async recentMessages(limit = 10): Promise<string[]> {
    this.git.cwd(this.paths.getWikiDir());
    const log = await this.git.log({ maxCount: limit });
    return log.all.map((c) => c.message);
  }

  // 원격 origin 보장(Phase 15b). ensureRepo 후 origin 추가(URL 바뀌면 set-url).
  async ensureRemote(url: string): Promise<void> {
    return this.serialize(async () => {
      await this.ensureRepo();
      this.git.cwd(this.paths.getWikiDir());
      const remotes = await this.git.getRemotes(true);
      const origin = remotes.find((r) => r.name === 'origin');
      if (!origin) await this.git.addRemote('origin', url);
      else if (origin.refs.fetch !== url && origin.refs.push !== url) {
        await this.git.remote(['set-url', 'origin', url]);
      }
    });
  }

  // HEAD 커밋 존재 여부(unborn 브랜치 판별).
  private async hasHead(): Promise<boolean> {
    return this.git.raw(['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false);
  }

  // 원격에서 받아 병합. 충돌 시 abort + 로컬 유지. 네트워크/원격없음은 조용히 스킵.
  async pull(branch: string): Promise<{ ok: boolean; conflict: boolean }> {
    return this.serialize(() => this.pullInner(branch));
  }

  // pull의 실제 로직(직렬화 미포함) — push의 내부 재시도가 이걸 직접 호출해 중첩 serialize를 피한다.
  private async pullInner(branch: string): Promise<{ ok: boolean; conflict: boolean }> {
    this.git.cwd(this.paths.getWikiDir());
    try {
      await this.git.fetch('origin', branch);
    } catch {
      return { ok: false, conflict: false }; // 네트워크/원격 접근 실패 → 다음 주기
    }
    // fetch 이후 단계 전체에 안전망(Fix #3): 예기치 못한 throw도 never-throw 계약({ok,conflict})으로 흡수.
    try {
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
      let mergeThrew = false;
      try {
        // --allow-unrelated-histories: 각 두뇌가 따로 git init해 커밋한 뒤 합류하면(마이그레이션)
        // 공통 조상이 없어 기본 merge가 거부된다. 다른 파일이면 자동 병합, 같은 파일이면 충돌(아래 abort).
        await this.git.raw(['merge', `origin/${branch}`, '--allow-unrelated-histories']);
      } catch {
        // 내용 충돌은 stdout에 찍혀 던지지 않지만, dirty working tree 등 다른 거부는 stderr로 던진다.
        mergeThrew = true;
      }
      const status = await this.git.status();
      if (status.conflicted.length > 0) {
        return await this.resolveConflicts(); // 15c: abort 대신 자동 병합
      }
      if (mergeThrew) {
        // 병합이 실제로는 완료되지 않았다(예: 같은 파일의 미커밋 변경으로 git이 거부).
        // status.conflicted가 비어 있어도 성공을 주장하면 안 된다 — 다음 주기에 재시도.
        await this.git.raw(['merge', '--abort']).catch(() => {});
        return { ok: false, conflict: false };
      }
      return { ok: true, conflict: false };
    } catch {
      return { ok: false, conflict: false };
    }
  }

  // 로컬 커밋을 원격에 push. 거부(원격 앞섬) → pull 후 1회 재시도.
  async push(branch: string): Promise<{ ok: boolean; conflict: boolean }> {
    return this.serialize(() => this.pushInner(branch));
  }

  // push의 실제 로직(직렬화 미포함). 내부 재시도는 pullInner를 직접 호출(pull의 serialize 재진입 방지).
  private async pushInner(branch: string): Promise<{ ok: boolean; conflict: boolean }> {
    // 전체에 안전망(Fix #3): 예기치 못한 throw도 never-throw 계약으로 흡수.
    try {
      this.git.cwd(this.paths.getWikiDir());
      if (!(await this.hasHead())) return { ok: true, conflict: false }; // 보낼 커밋 없음
      await this.git.raw(['branch', '-M', branch]).catch(() => {});
      try {
        await this.git.push('origin', branch);
        return { ok: true, conflict: false };
      } catch {
        const p = await this.pullInner(branch);
        if (p.conflict) return { ok: false, conflict: true };
        try {
          await this.git.push('origin', branch);
          return { ok: true, conflict: false };
        } catch {
          return { ok: false, conflict: false }; // 다음 주기 재시도
        }
      }
    } catch {
      return { ok: false, conflict: false };
    }
  }

  // 충돌한 위키 페이지들을 자동 병합(15c). frontmatter 규칙 + 본문 3-way(겹침→두뇌/union).
  // 실패 시 abort로 되돌려(15b) 안전 유지 — sync 루프 불사.
  // 주의: commitAll(serialize 래핑)을 부르지 않고 git.add/commit을 직접 호출(이미 pullInner=뮤텍스 내부).
  private async resolveConflicts(): Promise<{ ok: boolean; conflict: boolean }> {
    try {
      const status = await this.git.status();
      for (const rel of status.conflicted) {
        if (!rel.endsWith('.md')) continue; // 위키 페이지만
        await this.resolveOnePage(rel);
      }
      const after = await this.git.status();
      if (after.conflicted.length > 0) { // .md 아닌 충돌이 남음 → 안전 abort
        await this.git.raw(['merge', '--abort']).catch(() => {});
        return { ok: true, conflict: true };
      }
      await this.git.commit('merge: reconcile concurrent wiki edits');
      return { ok: true, conflict: false };
    } catch {
      await this.git.raw(['merge', '--abort']).catch(() => {}); // 해결 실패 → 15b 폴백
      return { ok: true, conflict: true };
    }
  }

  private async resolveOnePage(rel: string): Promise<void> {
    const slug = path.basename(rel, '.md');
    const oursRaw = await this.showStage(2, rel);
    const theirsRaw = await this.showStage(3, rel);
    // delete/modify 충돌: 한쪽 스테이지가 없음 = 그쪽이 삭제. "삭제가 이김" — 내용 병합 없이 삭제를 스테이징.
    // 양쪽 다 삭제(delete/delete)는 git이 자동 병합해 애초에 충돌 목록에 안 들어온다.
    if (oursRaw == null || theirsRaw == null) {
      await this.git.raw(['rm', '--force', rel]);
      return;
    }
    const ours = parsePage(slug, oursRaw);
    const theirs = parsePage(slug, theirsRaw);
    const frontmatter = reconcileFrontmatter(ours.frontmatter, theirs.frontmatter);
    const baseRaw = await this.showStage(1, rel); // 없을 수 있음(add/add)
    const baseBody = baseRaw != null ? parsePage(slug, baseRaw).body : '';
    const body = await this.mergeBody(baseBody, ours.body, theirs.body);
    const merged = serializePage({ slug, frontmatter, body });
    await fs.writeFile(path.join(this.paths.getWikiDir(), rel), merged, 'utf8');
    await this.git.add(rel);
  }

  // 인덱스 스테이지(1=base,2=ours,3=theirs)의 파일 내용. 없으면 null.
  private async showStage(stage: 1 | 2 | 3, rel: string): Promise<string | null> {
    return this.git.raw(['show', `:${stage}:${rel}`]).then((s) => s).catch(() => null);
  }

  // 본문 3-way. 깨끗하면 병합본문, 진짜 겹침이면 bodyMerger→union.
  private async mergeBody(baseBody: string, oursBody: string, theirsBody: string): Promise<string> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-bodymerge-'));
    try {
      const o = path.join(tmp, 'o'), b = path.join(tmp, 'b'), t = path.join(tmp, 't');
      await fs.writeFile(o, oursBody); await fs.writeFile(b, baseBody); await fs.writeFile(t, theirsBody);
      // git merge-file -p -q <ours> <base> <theirs> → stdout. 충돌 시 마커 포함(또는 non-zero exit로 throw).
      let merged: string | null = null;
      try { merged = await this.git.raw(['merge-file', '-p', '-q', o, b, t]); } catch { merged = null; }
      // '<<<<<<<'를 포함하면 충돌로 간주(두뇌/union). 본문이 리터럴 '<<<<<<<'를 담은 극히 드문
      // 경우 오분류될 수 있으나 union이 양쪽을 보존하므로 손실은 없다.
      if (merged != null && !merged.includes('<<<<<<<')) return merged; // 깨끗
      // 진짜 겹침 → 두뇌 병합 시도 → 실패/미주입 시 union
      if (this.bodyMerger) {
        const m = await this.bodyMerger(oursBody, theirsBody).catch(() => null);
        if (m && m.trim()) return m;
      }
      return unionBodies(oursBody, theirsBody);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
}
