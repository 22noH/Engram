import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// '+ 로컬 두뇌'(스펙 §2.1/§2.5) 목록 영속. 실행은 desktop main이 brain 모드로 fork.

export interface LocalBrain { id: string; name: string; port: number; dataDir: string }

function file(configDir: string): string { return path.join(configDir, 'local-brains.json'); }

export function loadLocalBrains(configDir: string): LocalBrain[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file(configDir), 'utf8')) as unknown;
    return Array.isArray(raw) ? raw as LocalBrain[] : [];
  } catch { return []; }
}

export function addLocalBrain(configDir: string, dataRoot: string, name: string, usedPorts: number[]): LocalBrain {
  const list = loadLocalBrains(configDir);
  const used = new Set([...usedPorts, ...list.map((b) => b.port)]);
  let port = 47801;
  while (used.has(port)) port++;
  const id = randomUUID();
  const b: LocalBrain = { id, name: name.trim() || 'Local brain', port, dataDir: path.join(dataRoot, 'brains', id) };
  list.push(b);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file(configDir), JSON.stringify(list, null, 2));
  return b;
}
