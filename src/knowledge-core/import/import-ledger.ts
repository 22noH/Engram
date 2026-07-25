import * as fs from 'fs/promises';
import * as path from 'path';

// 처리 이력(상태 파일). 원본 파일은 절대 건드리지 않는다(이동·이름변경·삭제 금지) —
// "처리됨" 표시는 오직 여기에만 남는다. 재처리 방지와 설정창의 "최근 처리" 목록이 같은 원천을 본다.

export type ImportStatus = 'done' | 'skipped' | 'failed' | 'pending';

export interface ImportRecord {
  /** 감시 폴더 기준 상대경로(폴더를 옮겨도 이력이 살아있게). */
  rel: string;
  name: string;
  size: number;
  mtimeMs: number;
  /** 내용 해시(sha256 앞 16자). size·mtime이 흔들려도 내용이 같으면 재처리하지 않는 근거. */
  hash?: string;
  status: ImportStatus;
  /** skipped/failed 사유 코드(SKIP_REASONS 또는 에러 요약). */
  reason?: string;
  ts: string;
  /** 만들어진(또는 덧붙인) 위키 slug들. */
  pages?: string[];
  op?: 'create' | 'append';
  /** 승인함으로 보냈을 때의 제안 id들. */
  proposals?: string[];
  /** 실패 재시도 횟수 — 상한을 넘으면 더 안 건드린다(비용 폭주 방지). */
  attempts?: number;
}

/** 같은 파일을 무한정 재시도하지 않는다. 내용이 바뀌면 attempts는 0부터 다시 센다. */
export const MAX_ATTEMPTS = 3;

interface LedgerFile {
  version: 1;
  records: ImportRecord[];
}

/**
 * 이전 기록과 현재 파일 상태를 비교해 "다시 처리해야 하는가"를 판정한다(순수 함수).
 *  - 기록이 없으면 처리
 *  - 크기가 다르면 처리(가장 싼 신호)
 *  - 해시를 아는 경우 해시로 최종 판정(mtime만 바뀐 touch는 재처리하지 않는다 — 비용)
 *  - 해시를 모르면 mtime으로 판정
 *  - pending(상한에 걸려 대기)은 항상 처리 대상
 *  - failed는 MAX_ATTEMPTS까지만
 */
export function needsProcessing(
  prev: ImportRecord | undefined,
  cur: { size: number; mtimeMs: number; hash?: string },
): boolean {
  if (!prev) return true;
  if (prev.status === 'pending') return true;
  const changed =
    prev.size !== cur.size ||
    (cur.hash !== undefined && prev.hash !== undefined
      ? cur.hash !== prev.hash
      : Math.abs(prev.mtimeMs - cur.mtimeMs) >= 1);
  if (changed) return true;
  if (prev.status === 'failed') return (prev.attempts ?? 1) < MAX_ATTEMPTS;
  return false; // done·skipped이고 내용도 그대로 → 다시 안 한다
}

/**
 * 크기·mtime만으로 "확실히 안 바뀌었다"고 말할 수 있는지. 참이면 해시 계산조차 건너뛴다
 * (대용량 파일에서 매 스캔마다 전체를 읽는 것을 막는 1차 관문).
 */
export function unchangedByStat(prev: ImportRecord | undefined, cur: { size: number; mtimeMs: number }): boolean {
  if (!prev) return false;
  if (prev.status === 'pending') return false;
  if (prev.status === 'failed' && (prev.attempts ?? 1) < MAX_ATTEMPTS) return false;
  return prev.size === cur.size && Math.abs(prev.mtimeMs - cur.mtimeMs) < 1;
}

/**
 * 상태 파일 저장소. never-throw — 깨진 파일은 빈 이력으로 시작하고, 쓰기 실패는 로그만 남기고
 * 다음 스캔에서 다시 시도한다(이력이 없으면 최악의 경우 재처리일 뿐, 데이터가 상하지는 않는다).
 */
export class ImportLedger {
  private records = new Map<string, ImportRecord>();
  private loaded = false;

  constructor(private readonly file: string, private readonly maxRecords = 500) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as LedgerFile;
      if (Array.isArray(parsed?.records)) {
        for (const r of parsed.records) if (r && typeof r.rel === 'string') this.records.set(r.rel, r);
      }
    } catch {
      // 없거나 깨짐 → 빈 이력
    }
  }

  get(rel: string): ImportRecord | undefined {
    return this.records.get(rel);
  }

  /** 기록을 넣고 즉시 저장한다(프로세스가 갑자기 죽어도 재처리가 최소화되게). */
  async put(r: ImportRecord): Promise<void> {
    this.records.set(r.rel, r);
    await this.save();
  }

  /** 최근 처리 순(ts 내림차순) n건 — 설정창 "최근 처리" 목록. */
  recent(n = 20): ImportRecord[] {
    return [...this.records.values()].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, n);
  }

  all(): ImportRecord[] {
    return [...this.records.values()];
  }

  counts(): Record<ImportStatus, number> {
    const out: Record<ImportStatus, number> = { done: 0, skipped: 0, failed: 0, pending: 0 };
    for (const r of this.records.values()) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }

  async save(): Promise<void> {
    // 오래된 기록부터 잘라 파일이 무한히 자라지 않게 한다(최근 maxRecords건만 보존).
    const sorted = [...this.records.values()].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, this.maxRecords);
    const body: LedgerFile = { version: 1, records: sorted };
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      // 임시파일 → rename(원자적 교체). 쓰다 죽어도 반쪽 JSON이 남지 않는다.
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(body, null, 2));
      await fs.rename(tmp, this.file);
      this.records = new Map(sorted.map((r) => [r.rel, r]));
    } catch {
      // 쓰기 실패는 삼킨다 — 다음 put에서 다시 시도된다(never-throw)
    }
  }
}
