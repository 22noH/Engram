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

  // 위키 디렉토리를 git 저장소로 보장(이미 init돼 있으면 신원만 확인).
  async ensureRepo(): Promise<void> {
    const dir = this.paths.getWikiDir();
    await fs.mkdir(dir, { recursive: true });
    this.git.cwd(dir);
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      await this.git.init();
    }
    // 데이터 저장소 전용 커밋 신원(코드 repo의 사용자와 분리).
    await this.git.addConfig('user.name', 'Engram');
    await this.git.addConfig('user.email', 'engram@localhost');
  }

  // 위키 디렉토리의 모든 변경을 커밋. 변경이 없으면 빈 커밋을 만들지 않는다.
  async commitAll(message: string): Promise<void> {
    this.git.cwd(this.paths.getWikiDir());
    await this.git.add('.');
    const status = await this.git.status();
    if (status.files.length === 0) return;
    await this.git.commit(message);
  }

  // 최근 커밋 메시지(최신순). 테스트·감사용.
  async recentMessages(limit = 10): Promise<string[]> {
    this.git.cwd(this.paths.getWikiDir());
    const log = await this.git.log({ maxCount: limit });
    return log.all.map((c) => c.message);
  }
}
