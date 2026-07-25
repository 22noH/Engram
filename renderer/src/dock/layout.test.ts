import {
  addTab, closePane, closeTab, defaultLayout, findPane, findPaneByTool, focusPane, focusedPane,
  legacyToolFor, listPanes, loadDock, makePane, makeTab, parseLayout, ptySessionKey, resizeSplit, saveDock,
  serializeLayout, setActiveTab, splitPane, terminalTabIds,
  type DockLayout, type PaneNode, type SplitNode,
} from './layout';

beforeEach(() => localStorage.clear());

function paneIds(l: DockLayout): string[] { return listPanes(l.root).map((p) => p.id); }

describe('기본 레이아웃', () => {
  it('칸 1개·탭 1개로 시작하고 그 칸이 포커스다', () => {
    const l = defaultLayout('terminal');
    expect(l.root.kind).toBe('pane');
    const pane = l.root as PaneNode;
    expect(pane.tool).toBe('terminal');
    expect(pane.tabs).toHaveLength(1);
    expect(pane.activeTabId).toBe(pane.tabs[0].id);
    expect(l.focusedPaneId).toBe(pane.id);
  });

  it('생성되는 id는 매번 다르다(저장된 예전 id와 겹치면 엉뚱한 칸을 조작한다)', () => {
    const ids = new Set([defaultLayout('browser'), defaultLayout('browser'), defaultLayout('browser')]
      .map((l) => (l.root as PaneNode).id));
    expect(ids.size).toBe(3);
  });
});

describe('분할', () => {
  it('아래로 분할하면 칸이 둘이 되고 새 칸이 포커스된다', () => {
    const l0 = defaultLayout('browser');
    const first = (l0.root as PaneNode).id;
    const l = splitPane(l0, first, 'col', 'terminal');
    expect(l.root.kind).toBe('split');
    const split = l.root as SplitNode;
    expect(split.dir).toBe('col');
    expect(split.sizes).toEqual([0.5, 0.5]);
    expect(listPanes(l.root)).toHaveLength(2);
    expect(split.children[0].id).toBe(first);          // 원래 칸이 앞
    expect(l.focusedPaneId).toBe(split.children[1].id); // 새 칸이 포커스
    expect((split.children[1] as PaneNode).tool).toBe('terminal');
  });

  it('3칸 이상은 중첩으로 만들어진다(자유 분할)', () => {
    let l = defaultLayout('browser');
    const a = paneIds(l)[0];
    l = splitPane(l, a, 'row', 'terminal');
    const b = l.focusedPaneId;
    l = splitPane(l, b, 'col', 'diff');
    expect(listPanes(l.root)).toHaveLength(3);
    expect(listPanes(l.root).map((p) => p.tool).sort()).toEqual(['browser', 'diff', 'terminal']);
  });

  it('없는 칸을 분할하면 원본 그대로', () => {
    const l = defaultLayout('browser');
    expect(splitPane(l, 'nope', 'col', 'terminal')).toBe(l);
  });

  it('원본 레이아웃을 변형하지 않는다(불변)', () => {
    const l0 = defaultLayout('browser');
    const before = JSON.stringify(l0);
    splitPane(l0, (l0.root as PaneNode).id, 'col', 'terminal');
    expect(JSON.stringify(l0)).toBe(before);
  });
});

describe('칸 닫기', () => {
  it('분할된 칸 하나를 닫으면 남은 칸이 그 자리를 통째로 차지한다(빈 칸 없음)', () => {
    let l = defaultLayout('browser');
    const a = paneIds(l)[0];
    l = splitPane(l, a, 'col', 'terminal');
    const b = l.focusedPaneId;
    const res = closePane(l, b);
    expect(res.layout!.root.kind).toBe('pane');
    expect(res.layout!.root.id).toBe(a);
    expect(res.removed!.tool).toBe('terminal');
  });

  it('닫힌 칸이 포커스였으면 포커스가 남은 칸으로 옮겨간다', () => {
    let l = defaultLayout('browser');
    const a = paneIds(l)[0];
    l = splitPane(l, a, 'col', 'terminal');
    const res = closePane(l, l.focusedPaneId);
    expect(res.layout!.focusedPaneId).toBe(a);
  });

  it('마지막 칸을 닫으면 layout=null(독 자체가 닫힌다)', () => {
    const l = defaultLayout('terminal');
    const res = closePane(l, (l.root as PaneNode).id);
    expect(res.layout).toBeNull();
    expect(res.removed!.tool).toBe('terminal');
  });

  it('닫힌 칸의 탭 목록을 돌려준다(터미널 세션 kill 대상 계산용)', () => {
    const t1 = makeTab(); const t2 = makeTab();
    const pane = makePane('terminal', [t1, t2]);
    const l: DockLayout = { root: pane, focusedPaneId: pane.id };
    const res = closePane(l, pane.id);
    expect(res.removed!.tabs.map((t) => t.id)).toEqual([t1.id, t2.id]);
  });

  it('3칸에서 가운데를 닫으면 나머지 2칸 구조가 유지된다', () => {
    let l = defaultLayout('browser');
    const a = paneIds(l)[0];
    l = splitPane(l, a, 'row', 'terminal');
    const b = l.focusedPaneId;
    l = splitPane(l, b, 'col', 'diff');
    const c = l.focusedPaneId;
    const res = closePane(l, b);
    expect(paneIds(res.layout!).sort()).toEqual([a, c].sort());
  });
});

describe('크기 조절', () => {
  it('경계 비율을 확정한다', () => {
    let l = defaultLayout('browser');
    l = splitPane(l, paneIds(l)[0], 'col', 'terminal');
    const sid = l.root.id;
    const r = resizeSplit(l, sid, 0.3);
    expect((r.root as SplitNode).sizes[0]).toBeCloseTo(0.3);
    expect((r.root as SplitNode).sizes[1]).toBeCloseTo(0.7);
  });

  it('한쪽이 완전히 사라지지 않게 제한한다', () => {
    let l = defaultLayout('browser');
    l = splitPane(l, paneIds(l)[0], 'col', 'terminal');
    expect((resizeSplit(l, l.root.id, -5).root as SplitNode).sizes[0]).toBeCloseTo(0.08);
    expect((resizeSplit(l, l.root.id, 99).root as SplitNode).sizes[0]).toBeCloseTo(0.92);
    expect((resizeSplit(l, l.root.id, NaN).root as SplitNode).sizes[0]).toBeCloseTo(0.5);
  });
});

describe('탭', () => {
  it('탭을 더하면 그 탭이 활성이 되고 그 칸이 포커스된다', () => {
    let l = defaultLayout('browser');
    const p = paneIds(l)[0];
    l = splitPane(l, p, 'col', 'terminal');
    const tab = makeTab({ url: 'http://localhost:5173' });
    l = addTab(l, p, tab);
    const pane = findPane(l, p)!;
    expect(pane.tabs).toHaveLength(2);
    expect(pane.activeTabId).toBe(tab.id);
    expect(l.focusedPaneId).toBe(p);
  });

  it('활성 탭을 닫으면 왼쪽 이웃이 활성이 된다', () => {
    const t1 = makeTab(); const t2 = makeTab(); const t3 = makeTab();
    const pane = makePane('browser', [t1, t2, t3]);
    let l: DockLayout = { root: pane, focusedPaneId: pane.id };
    l = setActiveTab(l, pane.id, t3.id);
    const res = closeTab(l, pane.id, t3.id);
    expect(findPane(res.layout!, pane.id)!.activeTabId).toBe(t2.id);
    expect(res.removedTabIds).toEqual([t3.id]);
  });

  it('비활성 탭을 닫아도 활성 탭은 그대로다', () => {
    const t1 = makeTab(); const t2 = makeTab();
    const pane = makePane('browser', [t1, t2]);
    const l: DockLayout = { root: pane, focusedPaneId: pane.id };
    const res = closeTab(l, pane.id, t2.id);
    expect(findPane(res.layout!, pane.id)!.activeTabId).toBe(t1.id);
  });

  it('마지막 탭을 닫으면 그 칸이 닫힌다', () => {
    let l = defaultLayout('browser');
    const a = paneIds(l)[0];
    l = splitPane(l, a, 'col', 'terminal');
    const b = l.focusedPaneId;
    const tabId = findPane(l, b)!.tabs[0].id;
    const res = closeTab(l, b, tabId);
    expect(paneIds(res.layout!)).toEqual([a]);
    expect(res.removedTabIds).toEqual([tabId]);
  });

  it('마지막 칸의 마지막 탭을 닫으면 독 전체가 닫힌다', () => {
    const l = defaultLayout('terminal');
    const pane = l.root as PaneNode;
    const res = closeTab(l, pane.id, pane.tabs[0].id);
    expect(res.layout).toBeNull();
    expect(res.removedTabIds).toEqual([pane.tabs[0].id]);
  });

  it('없는 탭을 닫으면 아무 일도 없다', () => {
    const l = defaultLayout('browser');
    const res = closeTab(l, (l.root as PaneNode).id, 'nope');
    expect(res.layout).toBe(l);
    expect(res.removedTabIds).toEqual([]);
  });
});

describe('탐색 도우미', () => {
  it('focusedPane은 포커스 id가 낡아도 항상 칸을 준다', () => {
    const l = { ...defaultLayout('browser'), focusedPaneId: 'stale' };
    expect(focusedPane(l).tool).toBe('browser');
  });

  it('focusPane은 없는 칸이면 무시한다', () => {
    const l = defaultLayout('browser');
    expect(focusPane(l, 'nope')).toBe(l);
  });

  it('findPaneByTool은 그 도구의 첫 칸을 준다', () => {
    let l = defaultLayout('browser');
    l = splitPane(l, paneIds(l)[0], 'col', 'terminal');
    expect(findPaneByTool(l, 'terminal')!.id).toBe(l.focusedPaneId);
    expect(findPaneByTool(l, 'diff')).toBeNull();
  });

  it('세션 키는 채널+탭으로 만들어져 패널을 접었다 펴도 같은 세션에 이어진다', () => {
    expect(ptySessionKey('w-code', 't-1')).toBe('w-code#t-1');
    expect(ptySessionKey('w-code', 't-1')).toBe(ptySessionKey('w-code', 't-1'));
    expect(ptySessionKey('w-code', 't-1')).not.toBe(ptySessionKey('w-code', 't-2'));
  });

  it('terminalTabIds는 터미널 칸의 탭만 모은다', () => {
    let l = defaultLayout('browser');
    l = splitPane(l, paneIds(l)[0], 'col', 'terminal');
    const term = findPane(l, l.focusedPaneId)!;
    l = addTab(l, term.id, makeTab());
    expect(terminalTabIds(l.root).sort()).toEqual(findPane(l, term.id)!.tabs.map((t) => t.id).sort());
  });
});

describe('직렬화 왕복', () => {
  it('분할·탭·활성탭·비율이 그대로 돌아온다', () => {
    let l = defaultLayout('browser');
    const a = paneIds(l)[0];
    l = addTab(l, a, makeTab({ url: 'http://localhost:5173', title: 'dev' }));
    l = splitPane(l, a, 'col', 'terminal');
    l = resizeSplit(l, l.root.id, 0.62);
    const back = parseLayout(serializeLayout(l)!)!;
    expect(back).toEqual(l);
  });

  it('diff 탭의 파일 경로를 보존한다', () => {
    const pane = makePane('diff', [makeTab({ file: 'src/a.ts' })]);
    const l: DockLayout = { root: pane, focusedPaneId: pane.id };
    const back = parseLayout(serializeLayout(l)!)!;
    expect((back.root as PaneNode).tabs[0].file).toBe('src/a.ts');
  });

  it('서버 탭의 serverId·command를 보존한다(앱 재시작 후에도 그 탭을 열면 서버가 다시 뜬다)', () => {
    const pane = makePane('terminal', [makeTab({ serverId: 'srv-1', command: 'npm run dev', title: 'renderer' })]);
    const l: DockLayout = { root: pane, focusedPaneId: pane.id };
    const t = (parseLayout(serializeLayout(l)!)!.root as PaneNode).tabs[0];
    expect(t).toMatchObject({ serverId: 'srv-1', command: 'npm run dev', title: 'renderer' });
  });

  it('data: URL 탭(HTML 크게보기)은 저장하지 않는다 — localStorage를 통째로 날릴 수 있다', () => {
    const t1 = makeTab({ url: 'http://localhost:5173' });
    const t2 = makeTab({ url: 'data:text/html,<h1>hi</h1>' });
    const pane = makePane('browser', [t1, t2]);
    const l: DockLayout = { root: pane, focusedPaneId: pane.id };
    const back = parseLayout(serializeLayout(l)!)!;
    expect((back.root as PaneNode).tabs.map((t) => t.id)).toEqual([t1.id]);
  });

  it('data: 탭 하나뿐인 칸은 통째로 빠지고, 그래도 남는 칸이 있으면 살아난다', () => {
    let l = defaultLayout('terminal');
    const term = paneIds(l)[0];
    l = splitPane(l, term, 'col', 'browser');
    l = updateFirstTabUrl(l, l.focusedPaneId, 'data:text/html,x');
    const back = parseLayout(serializeLayout(l)!)!;
    expect(paneIds(back)).toEqual([term]);
  });

  it('저장할 게 하나도 안 남으면 null(=닫힘)', () => {
    const pane = makePane('browser', [makeTab({ url: 'data:text/html,x' })]);
    expect(serializeLayout({ root: pane, focusedPaneId: pane.id })).toBeNull();
  });
});

function updateFirstTabUrl(l: DockLayout, paneId: string, url: string): DockLayout {
  const pane = findPane(l, paneId)!;
  const tabs = pane.tabs.map((t, i) => (i === 0 ? { ...t, url } : t));
  const walk = (n: typeof l.root): typeof l.root =>
    (n.kind === 'pane'
      ? (n.id === paneId ? { ...n, tabs } : n)
      : { ...n, children: [walk(n.children[0]), walk(n.children[1])] as [typeof l.root, typeof l.root] });
  return { ...l, root: walk(l.root) };
}

describe('깨진 값 폴백', () => {
  it.each([
    ['null', null],
    ['빈 문자열', ''],
    ['JSON이 아님', '{{{'],
    ['root 없음', '{"v":1}'],
    ['root가 숫자', '{"root":42}'],
    ['모르는 kind', '{"root":{"kind":"wat","id":"x"}}'],
    ['모르는 tool', '{"root":{"kind":"pane","id":"p","tool":"nuke","tabs":[{"id":"t"}]}}'],
    ['탭 배열 비어있음', '{"root":{"kind":"pane","id":"p","tool":"browser","tabs":[]}}'],
    ['탭이 배열이 아님', '{"root":{"kind":"pane","id":"p","tool":"browser","tabs":"x"}}'],
    ['칸 id 중복', '{"root":{"kind":"split","id":"s","dir":"col","sizes":[0.5,0.5],"children":['
      + '{"kind":"pane","id":"p","tool":"browser","tabs":[{"id":"t1"}]},'
      + '{"kind":"pane","id":"p","tool":"terminal","tabs":[{"id":"t2"}]}]}}'],
  ])('%s → null', (_name, raw) => {
    expect(parseLayout(raw as string | null)).toBeNull();
  });

  it('한쪽 자식만 성한 split은 성한 쪽만 살린다(전부 버리지 않는다)', () => {
    const raw = '{"root":{"kind":"split","id":"s","dir":"col","sizes":[0.5,0.5],"children":['
      + '{"kind":"pane","id":"p1","tool":"browser","tabs":[{"id":"t1"}]},'
      + '{"kind":"pane","id":"p2","tool":"nuke","tabs":[{"id":"t2"}]}]}}';
    const l = parseLayout(raw)!;
    expect(paneIds(l)).toEqual(['p1']);
    expect(l.focusedPaneId).toBe('p1');
  });

  it('낡은 focusedPaneId·이상한 sizes·모르는 dir은 안전한 값으로 교정한다', () => {
    const raw = '{"focusedPaneId":"gone","root":{"kind":"split","id":"s","dir":"zzz","sizes":["x",9],"children":['
      + '{"kind":"pane","id":"p1","tool":"browser","tabs":[{"id":"t1"}],"activeTabId":"missing"},'
      + '{"kind":"pane","id":"p2","tool":"terminal","tabs":[{"id":"t2"}]}]}}';
    const l = parseLayout(raw)!;
    expect(l.focusedPaneId).toBe('p1');
    expect((l.root as SplitNode).dir).toBe('col');
    expect((l.root as SplitNode).sizes).toEqual([0.5, 0.5]);
    expect((listPanes(l.root)[0]).activeTabId).toBe('t1');
  });

  it('저장된 탭의 data: URL은 읽을 때도 버린다', () => {
    const raw = '{"root":{"kind":"pane","id":"p","tool":"browser","tabs":[{"id":"t","url":"data:text/html,x"}]}}';
    expect(listPanes(parseLayout(raw)!.root)[0].tabs[0].url).toBeUndefined();
  });
});

describe('채널별 퍼시스트 + 기존 단일 패널 이관', () => {
  it('저장하고 다시 읽으면 같은 레이아웃', () => {
    let l = defaultLayout('browser');
    l = splitPane(l, paneIds(l)[0], 'col', 'terminal');
    saveDock('ch1', l);
    expect(loadDock('ch1')).toEqual(l);
  });

  it('저장 안 한 채널은 null(=닫힘)', () => {
    expect(loadDock('없는채널')).toBeNull();
  });

  it('null 저장은 닫힘으로 기록한다', () => {
    saveDock('ch1', defaultLayout('browser'));
    saveDock('ch1', null);
    expect(loadDock('ch1')).toBeNull();
  });

  it('기존 단일 패널 값(preview)이 브라우저 칸 기본 레이아웃으로 이관된다', () => {
    localStorage.setItem('engram.codePanel.open', JSON.stringify({ ch1: 'preview', ch2: 'terminal', ch3: 'diff' }));
    expect(legacyToolFor('ch1')).toBe('browser');
    const l = loadDock('ch1')!;
    expect((l.root as PaneNode).tool).toBe('browser');
    expect((loadDock('ch2')!.root as PaneNode).tool).toBe('terminal');
    expect((loadDock('ch3')!.root as PaneNode).tool).toBe('diff');
  });

  it('독 레이아웃을 저장하면 예전 키의 그 채널 항목은 지워진다(이관이 되살아나지 않게)', () => {
    localStorage.setItem('engram.codePanel.open', JSON.stringify({ ch1: 'preview', other: 'diff' }));
    saveDock('ch1', defaultLayout('terminal'));
    saveDock('ch1', null);
    expect(loadDock('ch1')).toBeNull();
    expect(legacyToolFor('other')).toBe('diff'); // 남의 채널은 안 건드린다
  });

  it('저장된 독 값이 깨졌으면 예전 값으로 이관, 그것도 없으면 닫힘', () => {
    localStorage.setItem('engram.dock.layout', JSON.stringify({ ch1: '{{{', ch2: '{{{' }));
    localStorage.setItem('engram.codePanel.open', JSON.stringify({ ch1: 'diff' }));
    expect((loadDock('ch1')!.root as PaneNode).tool).toBe('diff');
    expect(loadDock('ch2')).toBeNull();
  });

  it('맵 자체가 깨져도 throw하지 않는다', () => {
    localStorage.setItem('engram.dock.layout', 'not json');
    localStorage.setItem('engram.codePanel.open', '[1,2,3]');
    expect(() => loadDock('ch1')).not.toThrow();
    expect(loadDock('ch1')).toBeNull();
  });
});
