import * as fs from 'fs';
import * as path from 'path';
import { MeetingDef } from '../agent-layer/meeting-engine';

const file = (dir: string): string => path.join(dir, 'meetings.json');

export function loadMeetings(configDir: string): MeetingDef[] {
  try { return JSON.parse(fs.readFileSync(file(configDir), 'utf8')) as MeetingDef[]; }
  catch { return []; }
}

export function saveMeetings(configDir: string, defs: MeetingDef[]): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file(configDir), JSON.stringify(defs, null, 2));
}
