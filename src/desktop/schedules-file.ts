import * as fs from 'fs';
import * as path from 'path';
import { ScheduleEntry } from '../agent-layer/schedule-store';

// 설정창용 schedules.json 직접 읽기/삭제. ★알려진 경합(스펙 §3.6): 서버가 메모리 사본을
// 들고 쓰는 파일 — 삭제는 재시작해야 크론에 반영되고, 재시작 전 서버 저장이 삭제분을
// 부활시킬 수 있다. ponytail: 낮은 확률 수용, 업그레이드 경로 = ws admin 프레임.
export function listSchedules(configDir: string): ScheduleEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'schedules.json'), 'utf8'));
    return Array.isArray(parsed) ? (parsed as ScheduleEntry[]) : [];
  } catch {
    return [];
  }
}

export function removeScheduleFromFile(configDir: string, id: string): boolean {
  const entries = listSchedules(configDir);
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  fs.writeFileSync(path.join(configDir, 'schedules.json'), JSON.stringify(next, null, 2));
  return true;
}
