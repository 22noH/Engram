import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { WikiPageMeta, WikiPageDto, ProposalDto, WikiSearchHit } from '../../../shared/protocol';
import { buildCategoryTree, normalizeCategoryPath, CATEGORY_FALLBACK, type CategoryNode } from '../../../shared/category-path';
import { renderMarkdown } from '../render/markdown';
import { T } from '../i18n';
import { ko } from '../config';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(ko ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric' });
}

function StatusPill({ status }: { status: WikiPageMeta['status'] }) {
  const label = status === 'published' ? T.wikiStatusPublished : T.wikiStatusDraft;
  return <span className={'pill' + (status === 'published' ? ' pub' : '')}>{label}</span>;
}

// 위키 영역: ① 페이지 읽기·의미검색(+게시 페이지 파괴적 행위) ② 승인함(두뇌 제안 승인/거부). 순수 프레젠테이션.
// 2026-07-19: 목업(docs/superpowers/mockups/2026-07-19-wiki-ui.html) 기준 시각 재구현 — 세그먼트+목록 위계·문서 타이포·승인함 카드.
// 기존 props/동작/권한 게이트는 전부 그대로, DOM 구조와 클래스만 목업에 맞춰 교체.
export function WikiArea(props: {
  pages: WikiPageMeta[];
  openPage: WikiPageDto | null;
  proposals: ProposalDto[];
  searchResults: WikiSearchHit[];
  canApprove: boolean;
  canUnpublish: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onOpenPage: (slug: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onUnpublish: (slug: string) => void;
  onEdit: (slug: string, body: string) => void;
  onDelete: (slug: string) => void;
  onSearch: (query: string) => void;
}) {
  const [tab, setTab] = useState<'pages' | 'inbox'>('pages');
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 열린 폴더. 처음 페이지 목록이 도착할 때 최상위 폴더를 한 번 펼쳐 둔다 — 접힌 폴더만 잔뜩
  // 보이면 위키가 비어 보인다. 그 뒤로는 사용자가 접고 펴는 대로만 따른다(자동 개입 없음).
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const seededFolders = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // onSearch의 최신 참조(App이 매 렌더 새 콜백을 넘겨도 디바운스 effect를 재실행하지 않기 위함 — App의 ref 패턴).
  const onSearchRef = useRef(props.onSearch); onSearchRef.current = props.onSearch;

  // 목업(2026-07-19) 레이아웃 픽스: 사이드바(세그먼트+검색+목록)는 #side(모드탭 아래) 안의 단일 컬럼에
  // 살아야 한다. Channels가 위키 모드일 때 #wikiSideSlot을 그 자리에 마운트해 두면, 여기서 그 DOM
  // 노드로 사이드바를 포털한다 — 별도 컬럼(#wikiArea 안 wikiSide)으로 새지 않는다.
  // 슬롯이 없으면(예: 이 컴포넌트 단독 렌더 테스트) 기존처럼 #wikiArea 안에 그대로 인라인 렌더(회귀 없음).
  const [sideSlot, setSideSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSideSlot(document.getElementById('wikiSideSlot')); }, []);

  // 다른 페이지로 전환하면 편집 모드 해제.
  useEffect(() => { setEditing(false); }, [props.openPage?.slug]);

  useEffect(() => {
    if (editing) return; // 편집 중엔 docBody 미마운트
    const el = bodyRef.current;
    if (el) el.replaceChildren(props.openPage ? renderMarkdown(props.openPage.body) : document.createDocumentFragment());
  }, [props.openPage, editing]);

  // 검색어 디바운스(300ms) → 서버 의미검색. 빈 쿼리면 검색 안 함(브라우즈 모드).
  useEffect(() => {
    const query = filter.trim();
    if (!query) return;
    const id = setTimeout(() => onSearchRef.current(query), 300);
    return () => clearTimeout(id);
  }, [filter]);

  const q = filter.trim();
  const open = props.openPage;
  const canAct = !!open && open.status === 'published'; // 게시 페이지만 대상
  const pendingCount = props.proposals.length;

  useEffect(() => {
    if (seededFolders.current || props.pages.length === 0) return;
    seededFolders.current = true;
    setOpenFolders(new Set(buildCategoryTree(props.pages.map((p) => p.category)).map((n) => n.path)));
  }, [props.pages]);

  const toggleFolder = (path: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const sidebar = (
    <div className="wikiSide">
      <div className="wikiSeg">
        <button type="button" className={'segBtn' + (tab === 'pages' ? ' on' : '')} onClick={() => setTab('pages')}>
          {T.wikiPages}
        </button>
        <button type="button" className={'segBtn' + (tab === 'inbox' ? ' on' : '')} onClick={() => setTab('inbox')}>
          {T.wikiInbox}
          {pendingCount > 0 && <span className="segBadge">{pendingCount}</span>}
        </button>
      </div>
      <div className="wikiSearch">
        <input type="text" placeholder={T.wikiSearchPh} value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="wikiList">
        {tab === 'pages' && (
          q === '' ? (
            // 페이지가 0장이면 백지였다 — 첫 실행 사용자에게는 이게 앱의 첫 화면인데
            // "비어 있음"인지 "고장"인지 구분이 안 됐다. 개발 머신은 페이지가 많아 안 보이던 화면.
            props.pages.length === 0 ? (
              <div className="empty">{T.wikiPagesEmpty}</div>
            ) : (
            // 폴더 트리(목업 승인 2026-07-27). 폴더는 고정 목록이 아니라 페이지들의 category에서
            // 파생된다 — 위키 내용이 바뀌면 트리도 따라 바뀐다. 폴더가 곧 분류라 페이지 줄에서
            // 분류 칩은 뺐다(같은 정보 두 번).
            <FolderTree
              pages={props.pages}
              openSlug={open?.slug}
              expanded={openFolders}
              onToggle={toggleFolder}
              onOpenPage={props.onOpenPage}
            />
            )
          ) : props.searchResults.length === 0 ? (
            <div className="empty">{T.wikiNoResults}</div>
          ) : (
            props.searchResults.map((h) => (
              <div key={h.slug} className={'pitem' + (open?.slug === h.slug ? ' sel' : '')} onClick={() => props.onOpenPage(h.slug)}>
                <div className="t">{h.title}</div>
                <div className="snippet">{h.snippet}</div>
              </div>
            ))
          )
        )}
      </div>
    </div>
  );

  return (
    <div id="wikiArea">
      {sideSlot ? createPortal(sidebar, sideSlot) : sidebar}

      <div className="wikiDocPane">
        {tab === 'pages' ? (
          <>
            {open && (
              <div className="dochdr">
                <div className="titles">
                  {/* Task 2(Quiet Library 시그니처) — 눈썹 줄: category/updated는 WikiPageDto가 항상 갖고
                      있는 필드(shared/protocol.ts)라 무조건 렌더(스킵 조건 없음). 순수 프레젠테이션, 아래
                      .meta의 기존 상태필/카테고리/날짜는 그대로 유지(기능 DOM 무변경). */}
                  <div className="eyebrow">{open.category} · {formatDate(open.updated)}</div>
                  <h2>{open.title}</h2>
                  <div className="meta">
                    <StatusPill status={open.status} />
                    <span className="cat">{open.category}</span>
                    <span className="date">{formatDate(open.updated)}</span>
                  </div>
                </div>
                {canAct && !editing && (
                  <div className="acts">
                    {props.canEdit && <button type="button" onClick={() => { setDraft(open.body); setEditing(true); }}>{T.wikiEdit}</button>}
                    {props.canUnpublish && <button type="button" className="danger" onClick={() => props.onUnpublish(open.slug)}>{T.wikiUnpublish}</button>}
                    {props.canDelete && <button type="button" className="danger" onClick={() => { if (window.confirm(T.wikiDeleteConfirm)) props.onDelete(open.slug); }}>{T.wikiDelete}</button>}
                  </div>
                )}
              </div>
            )}
            {editing && open ? (
              <div className="docEdit">
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} />
                <div className="docEditActions">
                  <button type="button" onClick={() => { props.onEdit(open.slug, draft); setEditing(false); }}>{T.wikiSave}</button>
                  <button type="button" onClick={() => setEditing(false)}>{T.wikiCancel}</button>
                </div>
              </div>
            ) : (
              <div className="docBody" ref={bodyRef} />
            )}
          </>
        ) : (
          <div className="inboxView">
            <h2>{T.wikiPendingCount(pendingCount)}</h2>
            <div className="sub">{T.wikiInboxSub}</div>
            {pendingCount === 0 && <div className="empty">{T.wikiInboxEmpty}</div>}
            {props.proposals.map((p) => (
              <div key={p.id} className="card">
                <div className="ct">{p.title}</div>
                <div className="who">
                  <span className={'opBadge ' + p.op}>{p.op}</span>
                  {` ${p.targetSlug} · ${Math.round(p.confidence * 100)}%`}
                  {p.conflictSlugs?.length ? ` · ⚠ ${p.conflictSlugs.join(', ')}` : ''}
                </div>
                <div className="reason">{p.reason}</div>
                <div className={'snip' + (expanded.has(p.id) ? ' open' : '')}>
                  <PropBody markdown={p.payload} />
                </div>
                <div className="cbtns">
                  {props.canApprove && <button type="button" className="approve" onClick={() => props.onApprove(p.id)}>{T.wikiApprove}</button>}
                  {props.canApprove && <button type="button" className="rejectb" onClick={() => props.onReject(p.id)}>{T.wikiReject}</button>}
                  <button type="button" className="diffb" onClick={() => toggleExpand(p.id)}>{T.wikiViewFull}</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 폴더 트리(목업 승인 2026-07-27) ────────────────────────────────────────────
// 폴더는 페이지들의 category에서 파생한다. 고정 목록이 아니라 위키가 실제로 갖게 된 것이라,
// 내용이 바뀌면 트리도 바뀐다. 분류가 없는 페이지는 맨 아래 "미분류" 한 칸으로 모은다 —
// 트리에서 사라지면 사용자는 페이지를 잃어버린 것으로 본다.
const UNSORTED = CATEGORY_FALLBACK;

function FolderTree(props: {
  pages: WikiPageMeta[];
  openSlug?: string;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpenPage: (slug: string) => void;
}) {
  const byPath = new Map<string, WikiPageMeta[]>();
  for (const p of props.pages) {
    const key = normalizeCategoryPath(p.category) ?? UNSORTED;
    const list = byPath.get(key);
    if (list) list.push(p); else byPath.set(key, [p]);
  }
  const roots = buildCategoryTree(props.pages.map((p) => p.category));
  // 미분류는 항상 맨 아래 — 정리된 폴더들이 먼저 보여야 한다.
  const ordered = [...roots.filter((n) => n.path !== UNSORTED), ...roots.filter((n) => n.path === UNSORTED)];

  const rows: ReactElement[] = [];
  const walk = (nodes: CategoryNode[], depth: number): void => {
    for (const node of nodes) {
      const isOpen = props.expanded.has(node.path);
      const total = countPages(node);
      rows.push(
        <div
          key={`f:${node.path}`}
          className={'wfolder' + (isOpen ? ' open' : '')}
          style={{ paddingLeft: 10 + depth * 12 }}
          onClick={() => props.onToggle(node.path)}
        >
          <span className="tw">{isOpen ? '▾' : '▸'}</span>
          <span className="fname">{node.path === UNSORTED ? T.wikiUnsorted : node.name}</span>
          <span className="fcount">{total}</span>
        </div>,
      );
      if (!isOpen) continue;
      walk(node.children, depth + 1);
      for (const p of byPath.get(node.path) ?? []) {
        rows.push(
          <div
            key={`p:${p.slug}`}
            className={'pitem' + (props.openSlug === p.slug ? ' sel' : '')}
            style={{ paddingLeft: 10 + (depth + 1) * 12 }}
            onClick={() => props.onOpenPage(p.slug)}
          >
            <div className="t">{p.title}</div>
            <div className="m">
              <StatusPill status={p.status} />
              <span className="date">{formatDate(p.updated)}</span>
            </div>
          </div>,
        );
      }
    }
  };
  walk(ordered, 0);
  return <>{rows}</>;
}

// 폴더가 품은 전체 페이지 수(하위 폴더 포함) — 접힌 폴더의 숫자가 실제보다 작아 보이면 안 된다.
function countPages(node: CategoryNode): number {
  return node.count + node.children.reduce((sum, c) => sum + countPages(c), 0);
}

// 제안 본문 미리보기 — 검증된 마크다운 빌더 재사용(XSS 안전).
function PropBody({ markdown }: { markdown: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.replaceChildren(renderMarkdown(markdown)); }, [markdown]);
  return <div className="propBody" ref={ref} />;
}
