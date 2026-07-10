import type { Connection } from './connections';
import type { Channel, Message } from '../../shared/protocol';

// 라우팅: 텍스트 앞부분 `@이름`(대소문자 무시) → 그 connId, 없으면 defaultConnId.
export function routeTarget(text: string, defaultConnId: string, connections: Connection[]): string {
  const m = text.trim().match(/^@(\S+)/);
  if (m) {
    const c = connections.find((c) => c.name.toLowerCase() === m[1].toLowerCase());
    if (c) return c.id;
  }
  return defaultConnId;
}

// 논리 채널: 그 mode인 채널 이름들의 합집합(정렬·중복 제거).
// mode에 'wiki'도 받는다(App의 mode state가 위키까지 포함하도록 넓어졌기 때문 — 위키는 채널 개념이
// 없어 실제로 c.mode==='wiki'인 채널은 존재하지 않으므로 그 경우 항상 빈 배열을 반환한다).
export function logicalChannels(channelsByConn: Record<string, Channel[]>, mode: 'chat' | 'code' | 'team' | 'wiki'): string[] {
  const names = new Set<string>();
  for (const list of Object.values(channelsByConn)) {
    for (const c of list) {
      if ((c.mode ?? 'chat') === mode) names.add(c.name);
    }
  }
  return [...names].sort();
}

// 스레드 머지: 각 연결의 메시지를 합쳐 anchor(비-threadId) ts 오름차순 정렬 + 각 anchor
// 뒤에 그 anchor를 threadId로 갖는 답들(ts순)을 붙인다.
// 앵커가 없는 답(orphan)은 뒤에 ts순으로 이어붙인다(드롭하지 않음 — 유실 방지가 더 안전).
export function mergeThreads(msgsByConnForName: Array<{ connId: string; messages: Message[] }>): Message[] {
  const all = msgsByConnForName.flatMap((c) => c.messages);
  const anchors = all.filter((m) => !m.threadId).sort((a, b) => a.ts.localeCompare(b.ts));
  const repliesByAnchor = new Map<string, Message[]>();
  const orphans: Message[] = [];
  const anchorIds = new Set(anchors.map((a) => a.id));

  for (const m of all) {
    if (!m.threadId) continue;
    if (!anchorIds.has(m.threadId)) {
      orphans.push(m);
      continue;
    }
    const list = repliesByAnchor.get(m.threadId) ?? [];
    list.push(m);
    repliesByAnchor.set(m.threadId, list);
  }

  const result: Message[] = [];
  for (const a of anchors) {
    result.push(a);
    const replies = (repliesByAnchor.get(a.id) ?? []).sort((x, y) => x.ts.localeCompare(y.ts));
    result.push(...replies);
  }
  orphans.sort((a, b) => a.ts.localeCompare(b.ts));
  result.push(...orphans);
  return result;
}

// team 모드는 기본 연결(그 서버) 하나로 스코프 — 다중연결 머지/라우팅 대상에서 제외.
// (Ask/Code는 원본 그대로 반환 → 기존 다중연결 경로 무변경.)
export function scopedConnections<C extends { id: string }>(
  connections: C[], mode: 'chat' | 'code' | 'team' | 'wiki', defaultConnId: string,
): C[] {
  return mode === 'team' ? connections.filter((c) => c.id === defaultConnId) : connections;
}

export function scopedChannels(
  channelsByConn: Record<string, Channel[]>, mode: 'chat' | 'code' | 'team' | 'wiki', defaultConnId: string,
): Record<string, Channel[]> {
  return mode === 'team' ? { [defaultConnId]: channelsByConn[defaultConnId] ?? [] } : channelsByConn;
}
