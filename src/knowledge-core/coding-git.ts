import { Injectable } from '@nestjs/common';
import simpleGit from 'simple-git';

// 타깃 외부 repo의 git 운전(설계 §4, §7). WikiGit 패턴 재사용하되 경로는 호출자가 준다.
// 코드는 타깃 격리 브랜치에만 — 팀 main 무손상.
@Injectable()
export class CodingGit {
  // 격리 브랜치 보장: 있으면 전환, 없으면 현재 HEAD에서 생성(-B = reset/create).
  async ensureBranch(targetPath: string, branch: string): Promise<void> {
    await simpleGit(targetPath).checkout(['-B', branch]);
  }

  async currentBranch(targetPath: string): Promise<string> {
    return (await simpleGit(targetPath).revparse(['--abbrev-ref', 'HEAD'])).trim();
  }

  async hasChanges(targetPath: string): Promise<boolean> {
    const s = await simpleGit(targetPath).status();
    return !s.isClean();
  }

  // 작업트리 전체 스테이징 후 커밋. 변경 없으면 생략(빈 커밋 방지).
  async commitAll(targetPath: string, message: string): Promise<void> {
    const g = simpleGit(targetPath);
    await g.add('.');
    const s = await g.status();
    if (s.staged.length === 0) return;
    await g.commit(message);
  }
}
