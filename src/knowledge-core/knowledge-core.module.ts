import { Module, OnModuleInit } from '@nestjs/common';
import { PathResolver } from '../pal/path-resolver';
import { WikiEngine } from './wiki/wiki-engine';
import { WikiGit } from './wiki/wiki-git';

// KnowledgeCore: 단일 진실원(설계 §5). 시작 시 위키 git 저장소를 보장한다.
@Module({
  providers: [
    { provide: PathResolver, useFactory: () => new PathResolver() },
    WikiGit,
    WikiEngine,
  ],
  exports: [WikiEngine],
})
export class KnowledgeCoreModule implements OnModuleInit {
  constructor(private readonly git: WikiGit) {}

  async onModuleInit(): Promise<void> {
    await this.git.ensureRepo();
  }
}
