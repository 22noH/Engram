import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { PinoLogger } from '../pal/logger';

export interface Persona {
  name: string;
  role: string;
  brain: string;
  tools: string[];
  invocation: ('summon' | 'schedule')[];
  board?: string;
  prompt: string;
}

// 페르소나 = .md 정의(클래스, 설계 §7.3). 런타임 상태는 별도 객체(이 레지스트리는 정의만 보관).
@Injectable()
export class PersonaRegistry {
  private personas = new Map<string, Persona>();
  constructor(
    private readonly personasDir: string,
    private readonly logger?: PinoLogger,
  ) {}

  async load(): Promise<void> {
    this.personas.clear();
    let files: string[] = [];
    try {
      files = (await fs.promises.readdir(this.personasDir)).filter((f) => f.endsWith('.md'));
    } catch {
      this.logger?.warn(`personas 디렉토리 없음: ${this.personasDir}`, 'PersonaRegistry');
      return;
    }
    for (const f of files) {
      try {
        const parsed = matter(await fs.promises.readFile(path.join(this.personasDir, f), 'utf8'));
        const fm = parsed.data as Record<string, unknown>;
        const name = typeof fm.name === 'string' ? fm.name : '';
        if (!name) { this.logger?.warn(`name 없는 페르소나 스킵: ${f}`, 'PersonaRegistry'); continue; }
        this.personas.set(name, {
          name,
          role: String(fm.role ?? ''),
          brain: String(fm.brain ?? 'claude'),
          tools: Array.isArray(fm.tools) ? fm.tools.map(String) : [],
          invocation: Array.isArray(fm.invocation) ? (fm.invocation as ('summon' | 'schedule')[]) : ['summon'],
          board: typeof fm.board === 'string' ? fm.board : undefined,
          prompt: parsed.content,
        });
      } catch (e) {
        this.logger?.warn(`페르소나 파싱 실패 ${f}: ${String(e)}`, 'PersonaRegistry');
      }
    }
  }

  get(name: string): Persona | undefined { return this.personas.get(name); }
  all(): Persona[] { return [...this.personas.values()]; }
}
