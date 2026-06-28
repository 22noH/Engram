import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PathResolver, DEFAULT_USER } from '../pal/path-resolver';

export interface ConversationRecord { ts: string; question: string; answer: string; sources?: string[] }

@Injectable()
export class ConversationStore {
  constructor(private readonly paths: PathResolver) {}

  private convDir(userId: string): string {
    return path.join(this.paths.getDataDir(), 'state', 'conversations', userId);
  }
  private cursorPath(): string {
    return path.join(this.paths.getDataDir(), 'state', 'ingest-cursor.json');
  }

  async append(userId: string = DEFAULT_USER, rec: ConversationRecord): Promise<void> {
    const dir = this.convDir(userId);
    await fs.mkdir(dir, { recursive: true });
    const day = rec.ts.slice(0, 10); // YYYY-MM-DD
    await fs.appendFile(path.join(dir, `${day}.jsonl`), JSON.stringify(rec) + '\n');
  }

  async since(userId: string = DEFAULT_USER, cursorTs: string | null): Promise<ConversationRecord[]> {
    const dir = this.convDir(userId);
    let files: string[];
    try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const out: ConversationRecord[] = [];
    for (const f of files) {
      const text = await fs.readFile(path.join(dir, f), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let rec: ConversationRecord;
        try { rec = JSON.parse(line) as ConversationRecord; }
        catch { continue; } // 크래시로 잘린/손상된 줄은 건너뜀(append-only 로그 회복탄력성)
        if (cursorTs === null || rec.ts > cursorTs) out.push(rec);
      }
    }
    return out.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  // 특정 날짜(YYYY-MM-DD) 한 파일만 읽는다(인사이트 일일 집계용 — 전체 스캔 회피).
  async readDay(userId: string = DEFAULT_USER, day: string): Promise<ConversationRecord[]> {
    const file = path.join(this.convDir(userId), `${day}.jsonl`);
    let text: string;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const out: ConversationRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as ConversationRecord); } catch { continue; } // 손상 줄 건너뜀
    }
    return out;
  }

  async readCursor(userId: string = DEFAULT_USER): Promise<string | null> {
    try {
      const map = JSON.parse(await fs.readFile(this.cursorPath(), 'utf8')) as Record<string, string>;
      return map[userId] ?? null;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }

  async writeCursor(userId: string = DEFAULT_USER, ts: string): Promise<void> {
    let map: Record<string, string> = {};
    try { map = JSON.parse(await fs.readFile(this.cursorPath(), 'utf8')); } catch { /* 없으면 새로 */ }
    map[userId] = ts;
    await fs.mkdir(path.dirname(this.cursorPath()), { recursive: true });
    await fs.writeFile(this.cursorPath(), JSON.stringify(map, null, 2));
  }
}
