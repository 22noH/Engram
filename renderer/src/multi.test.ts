import { it, expect } from 'vitest';
import { routeTarget, logicalChannels, mergeThreads } from './multi';

const conns = [{ id: 'home', name: '집', endpoint: '' }, { id: 'work', name: '회사', endpoint: '' }];

it('routeTarget: @name → that conn, else default', () => {
  expect(routeTarget('@회사 배포됐어?', 'home', conns)).toBe('work');
  expect(routeTarget('그냥 질문', 'home', conns)).toBe('home');
  expect(routeTarget('@집 안녕', 'work', conns)).toBe('home');
});
it('logicalChannels: union of names by mode', () => {
  const byConn = {
    home: [{ id: 'h1', name: '일반', respondMode: 'all', mode: 'chat' }] as any,
    work: [{ id: 'w1', name: '일반', respondMode: 'all', mode: 'chat' }, { id: 'w2', name: '배포', respondMode: 'all', mode: 'chat' }] as any,
  };
  expect(logicalChannels(byConn, 'chat')).toEqual(['배포', '일반']);
});
it('mergeThreads: anchors sorted by ts, replies kept under anchor', () => {
  const a = { messages: [{ id: 'm1', authorId: 'owner', text: 'q', ts: '2026-01-01T00:00:00Z' }] } as any;
  const b = { messages: [
    { id: 'm2', authorId: 'owner', text: 'q2', ts: '2026-01-01T00:01:00Z' },
    { id: 'm2r', authorId: 'engram', text: 'a2', ts: '2026-01-01T00:01:05Z', threadId: 'm2' },
  ] } as any;
  const merged = mergeThreads([{ connId: 'home', ...a }, { connId: 'work', ...b }]);
  expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm2r']);
});

it('mergeThreads: anchors from different connections interleaved by ts', () => {
  const a = { messages: [{ id: 'm3', authorId: 'owner', text: 'later', ts: '2026-01-01T00:05:00Z' }] } as any;
  const b = { messages: [{ id: 'm1', authorId: 'owner', text: 'earlier', ts: '2026-01-01T00:00:00Z' }] } as any;
  const merged = mergeThreads([{ connId: 'home', ...a }, { connId: 'work', ...b }]);
  expect(merged.map((m) => m.id)).toEqual(['m1', 'm3']);
});

it('mergeThreads: replies sorted by ts under their anchor, even out of input order', () => {
  const a = { messages: [
    { id: 'm1', authorId: 'owner', text: 'q', ts: '2026-01-01T00:00:00Z' },
    { id: 'm1r2', authorId: 'engram', text: 'second reply', ts: '2026-01-01T00:02:00Z', threadId: 'm1' },
    { id: 'm1r1', authorId: 'engram', text: 'first reply', ts: '2026-01-01T00:01:00Z', threadId: 'm1' },
  ] } as any;
  const merged = mergeThreads([{ connId: 'home', ...a }]);
  expect(merged.map((m) => m.id)).toEqual(['m1', 'm1r1', 'm1r2']);
});

it('mergeThreads: orphan replies (anchor missing) are appended at the end', () => {
  const a = { messages: [
    { id: 'm1', authorId: 'owner', text: 'q', ts: '2026-01-01T00:00:00Z' },
    { id: 'orphan', authorId: 'engram', text: 'reply to missing anchor', ts: '2026-01-01T00:00:30Z', threadId: 'missing' },
  ] } as any;
  const merged = mergeThreads([{ connId: 'home', ...a }]);
  expect(merged.map((m) => m.id)).toEqual(['m1', 'orphan']);
});
