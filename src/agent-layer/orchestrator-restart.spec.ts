import { Orchestrator } from './orchestrator';
import { TaskRecord, TaskStatus } from '../knowledge-core/task-store';

const logger = { warn() {}, error() {}, log() {} } as any;

// 인메모리 TaskStore 대역 — list/remove/createCoding/transition만 orchestrator가 씀(Task 3 인터페이스).
function fakeTaskStore() {
  const byId = new Map<string, TaskRecord>();
  let seq = 0;
  return {
    async createCoding(input: { question: string; projectRef: string; criteriaTotal: number; channelId?: string }): Promise<TaskRecord> {
      const now = new Date().toISOString();
      const id = `task_${now.replace(/[:.]/g, '-')}_${(seq++).toString(36)}_code`;
      const rec: TaskRecord = {
        id, kind: 'coding', status: 'PENDING', question: input.question,
        assignees: [], blackboard: {}, result: null, createdAt: now, updatedAt: now,
        projectRef: input.projectRef, tickets: [],
        progress: { landed: 0, criteriaMet: 0, criteriaTotal: input.criteriaTotal },
        ...(input.channelId ? { channelId: input.channelId } : {}),
      };
      byId.set(id, rec);
      return rec;
    },
    async transition(id: string, to: TaskStatus): Promise<TaskRecord> {
      const rec = byId.get(id);
      if (!rec) throw new Error(`레코드 없음: ${id}`);
      rec.status = to;
      return rec;
    },
    async remove(id: string): Promise<void> {
      byId.delete(id);
    },
    async list(): Promise<TaskRecord[]> {
      return [...byId.values()];
    },
  };
}

// 생성자 18인자: (reader, conversations, logger, ingester, tasks, specialist, synth, sem,
//   projects, gate, codingGit, coder, reviewer, codeBrain, fence, reporter, registry, paths)
function makeOrchestrator(tasks: ReturnType<typeof fakeTaskStore>) {
  const conversations = { append: async () => {} } as any;
  const projects = { get: async (id: string) => ({ id, targetPath: 'C:/repos/api', approved: true }) } as any;
  const fence = { assertWritable() {} } as any;
  return new Orchestrator(
    null as any, conversations, logger, null as any,
    tasks as any, null as any, null as any, null as any,
    projects, null as any, null as any, null as any, null as any,
    null as any, fence, null as any, null as any, null as any,
  );
}

describe('Orchestrator.resumeInterrupted', () => {
  it('RUNNING 코딩 레코드를 채널로 재개하고 스테일 레코드를 지운다', async () => {
    const tasks = fakeTaskStore();
    const orch = makeOrchestrator(tasks) as any;
    const rec = await tasks.createCoding({ question: 'q', projectRef: 'p1', criteriaTotal: 1, channelId: 'chan-1' });
    await tasks.transition(rec.id, 'RUNNING');
    const spyHandle = jest.spyOn(orch, 'handleMention').mockResolvedValue(undefined);
    const spyRemove = jest.spyOn(tasks, 'remove');
    const posts: Array<[string, string]> = [];
    const n = await orch.resumeInterrupted(async (ch: string, t: string) => { posts.push([ch, t]); });
    expect(n).toBe(1);
    expect(spyHandle).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'resume p1', userId: 'chan-1' }),
      expect.any(Function),
      'chan-1',
    );
    expect(spyRemove).toHaveBeenCalledWith(rec.id);
  });

  it('channelId 없는 레코드는 재개하지 않는다(게시 대상 불명)', async () => {
    const tasks = fakeTaskStore();
    const orch = makeOrchestrator(tasks) as any;
    await tasks.createCoding({ question: 'q', projectRef: 'p1', criteriaTotal: 1 });
    const rec = (await tasks.list())[0];
    await tasks.transition(rec.id, 'RUNNING');
    const n = await orch.resumeInterrupted(async () => {});
    expect(n).toBe(0);
  });

  it('RUNNING이 아니거나 코딩이 아닌 레코드는 무시', async () => {
    const tasks = fakeTaskStore();
    const orch = makeOrchestrator(tasks) as any;
    await tasks.createCoding({ question: 'q', projectRef: 'p1', criteriaTotal: 1, channelId: 'c' }); // PENDING
    const n = await orch.resumeInterrupted(async () => {});
    expect(n).toBe(0);
  });

  it('TaskStore 미주입이면 0 반환', async () => {
    const conversations = { append: async () => {} } as any;
    const fence = { assertWritable() {} } as any;
    const orch = new Orchestrator(
      null as any, conversations, logger, null as any,
      undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      undefined, fence, undefined, undefined, undefined,
    ) as any;
    const n = await orch.resumeInterrupted(async () => {});
    expect(n).toBe(0);
  });
});
