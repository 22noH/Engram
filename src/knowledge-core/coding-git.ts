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

  // 완료 보고서 재료(2026-07-25) — "이번 실행이 실제로 바꾼 것". 실행 시작 시 HEAD를 찍어두고
  // (head) 끝에 그 지점부터의 변경 통계를 낸다(diffStat). 보고서는 사람에게 보이는 글이라 여기서
  // 실패해도 절대 던지지 않는다(빈 결과 → 보고서에 "바뀐 파일" 절이 빠질 뿐).
  async head(targetPath: string): Promise<string | null> {
    try { return (await simpleGit(targetPath).revparse(['HEAD'])).trim(); } catch { return null; }
  }

  async diffStat(targetPath: string, fromSha: string): Promise<Array<{ path: string; added: number; removed: number }>> {
    try {
      const s = await simpleGit(targetPath).diffSummary([`${fromSha}..HEAD`]);
      return s.files.map((f) => ({
        path: f.file,
        // 바이너리 파일은 insertions/deletions가 없다(binary:true) — 0으로 눌러 NaN이 새지 않게.
        added: 'insertions' in f ? f.insertions : 0,
        removed: 'deletions' in f ? f.deletions : 0,
      }));
    } catch { return []; }
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
