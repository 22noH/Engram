import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { ScheduleService } from './schedule-service';
import { ScheduleStore } from '../agent-layer/schedule-store';
import { FakeMessenger } from './messenger/fake-messenger';

function tmpStore(): ScheduleStore { return new ScheduleStore(fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ss-'))); }
const logger = { warn() {} } as any;
// 실 cron 타이머를 피하려고 makeJob을 no-op으로 덮은 서비스.
function service(orchestrator: any, port: any, registry: any, store: ScheduleStore) {
  const svc = new ScheduleService(orchestrator, port, registry, store, logger);
  (svc as any).makeJob = () => ({ start() {}, stop() {} });
  return svc;
}
function fakeRegistry() {
  const added: string[] = []; const deleted: string[] = [];
  return { added, deleted, addCronJob: (n: string) => added.push(n), deleteCronJob: (n: string) => deleted.push(n) };
}

it('add: 잘못된 cron → null(저장 안 함)', () => {
  const store = tmpStore();
  const svc = service({}, new FakeMessenger(), fakeRegistry(), store);
  expect(svc.add({ channelId: 'c1', cron: 'not a cron', task: 'X' })).toBeNull();
  expect(store.all()).toHaveLength(0);
});

it('add: 유효 cron → 저장 + registry 등록', () => {
  const store = tmpStore();
  const reg = fakeRegistry();
  const svc = service({}, new FakeMessenger(), reg, store);
  const e = svc.add({ channelId: 'c1', cron: '0 9 * * *', task: 'X' });
  expect(e).not.toBeNull();
  expect(store.all()).toHaveLength(1);
  expect(reg.added).toEqual([`sched-${e!.id}`]);
});

it('fire: 저장된 task를 handleMention으로 재주입 → post가 채널로', async () => {
  const store = tmpStore();
  const port = new FakeMessenger();
  const orchestrator = { handleMention: async (_msg: any, post: any) => { await post('결과'); } };
  const svc = service(orchestrator, port, fakeRegistry(), store);
  const e = store.add({ channelId: 'c1', threadId: 't1', cron: '0 9 * * *', task: '서버비 정리' });
  svc.fire(e);
  await new Promise((r) => setImmediate(r)); // detached handleMention flush
  expect(port.channelPosts).toEqual([{ channelId: 'c1', threadId: 't1', text: '결과' }]);
});

it('fire once: 발사 후 remove(store + registry)', async () => {
  const store = tmpStore();
  const reg = fakeRegistry();
  const orchestrator = { handleMention: async () => {} };
  const svc = service(orchestrator, new FakeMessenger(), reg, store);
  const e = store.add({ channelId: 'c1', cron: '0 9 * * *', task: 'X', once: true });
  svc.fire(e);
  await new Promise((r) => setImmediate(r));
  expect(store.all()).toHaveLength(0);
  expect(reg.deleted).toEqual([`sched-${e.id}`]);
});

it('remove: registry.deleteCronJob + store.remove', () => {
  const store = tmpStore();
  const reg = fakeRegistry();
  const svc = service({}, new FakeMessenger(), reg, store);
  const e = store.add({ channelId: 'c1', cron: '0 9 * * *', task: 'X' });
  expect(svc.remove(e.id)).toBe(true);
  expect(reg.deleted).toEqual([`sched-${e.id}`]);
});

it('start: 저장된 예약을 로드·등록', () => {
  const store = tmpStore();
  store.add({ channelId: 'c1', cron: '0 9 * * *', task: 'A' });
  store.add({ channelId: 'c2', cron: '0 10 * * *', task: 'B' });
  const reg = fakeRegistry();
  const svc = service({}, new FakeMessenger(), reg, store);
  svc.start();
  expect(reg.added).toHaveLength(2);
});

it('add: 6필드(초 단위) cron → null(5필드만 허용)', () => {
  const store = tmpStore();
  const svc = service({}, new FakeMessenger(), fakeRegistry(), store);
  expect(svc.add({ channelId: 'c1', cron: '* * * * * *', task: 'X' })).toBeNull();
  expect(store.all()).toHaveLength(0);
});

it('발사 중에는 재예약(add) 거부 — 재진입 루프 차단', async () => {
  const store = tmpStore();
  let svc: any;
  let reAdd: any = 'notset';
  const orchestrator = { handleMention: async () => { reAdd = svc.add({ channelId: 'c1', cron: '0 9 * * *', task: '재예약' }); } };
  svc = service(orchestrator, new FakeMessenger(), fakeRegistry(), store);
  const e = store.add({ channelId: 'c1', cron: '0 9 * * *', task: 'X' });
  svc.fire(e);
  await new Promise((r) => setImmediate(r));
  expect(reAdd).toBeNull();
});
