// 미니 마크다운 렌더러: innerHTML 없이 DOM 노드로만 조립(XSS 차단 유지).
// 지원: **굵게** *기울임* `코드` ```코드블록``` 목록(-/1.) 제목(#) 링크(http/https만).
// src/desktop/chat.html에서 verbatim 이전(회귀0 근거) — 로직 변경 없음, 최소 타입 주석만 추가.

function mdLink(url: string, label: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = url; // 정규식이 http/https만 매치 — javascript: 등 차단
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = label;
  return a;
}
function mdInline(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  // 마지막 두 그룹: 등락 화살표 칩(▲/△ 상승=초록, ▼/▽ 하락=빨강). 명시적 화살표만 색칠(오탐 방지).
  const re = /(`[^`\n]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()"']+)|([▲△🔺]\s?[+\-]?[\d.,]+%?)|([▼▽🔻]\s?[+\-]?[\d.,]+%?)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) { const c = document.createElement('code'); c.textContent = m[1].slice(1, -1); frag.appendChild(c); }
    else if (m[2]) { const b = document.createElement('strong'); b.appendChild(mdInline(m[2].slice(2, -2))); frag.appendChild(b); }
    else if (m[3]) { const i = document.createElement('em'); i.appendChild(mdInline(m[3].slice(1, -1))); frag.appendChild(i); }
    else if (m[4]) { frag.appendChild(mdLink(m[5], m[4])); }
    else if (m[6]) { frag.appendChild(mdLink(m[6], m[6])); }
    else if (m[7]) { const s = document.createElement('span'); s.className = 'up'; s.textContent = m[7]; frag.appendChild(s); }
    else if (m[8]) { const s = document.createElement('span'); s.className = 'down'; s.textContent = m[8]; frag.appendChild(s); }
    last = re.lastIndex;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}
// 인라인 SVG 차트(외부 라이브러리 0). ```chart JSON 블록을 막대/선 그래프로.
// spec: {"type":"bar"|"line","title":"...","labels":[...],"values":[num,...],"unit":"%"}
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(name: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const e = document.createElementNS(SVG_NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k] as unknown as string);
  if (text != null) e.textContent = text; // 외부 문자열은 textContent로만
  return e as SVGElement;
}
function renderChart(jsonText: string): HTMLDivElement | null {
  let spec: any; try { spec = JSON.parse(jsonText); } catch { return null; }
  const labels = Array.isArray(spec.labels) ? spec.labels.map(String) : [];
  const values = Array.isArray(spec.values) ? spec.values.map(Number) : [];
  if (!values.length || values.some((v: number) => !isFinite(v)) || labels.length !== values.length) return null;
  const type = spec.type === 'line' ? 'line' : spec.type === 'pie' ? 'pie' : 'bar';
  const unit = typeof spec.unit === 'string' ? spec.unit : '';
  const titleEl = () => {
    if (typeof spec.title === 'string' && spec.title) {
      const t = document.createElement('div'); t.className = 'ctitle'; t.textContent = spec.title; return t;
    }
    return null;
  };
  const PAL = ['#3aa5de', '#7ec8e3', '#5fb0d0', '#a7d8ee', '#2e86c1', '#9bc9e0', '#4aa0cf', '#cbe7f5'];
  if (type === 'pie') {
    const wrap = document.createElement('div'); wrap.className = 'chart';
    const t = titleEl(); if (t) wrap.appendChild(t);
    const total = values.reduce((a: number, b: number) => a + Math.max(0, b), 0) || 1;
    const cx = 92, cy = 95, r = 74, ir = 42;
    const svg = svgEl('svg', { viewBox: '0 0 400 200', preserveAspectRatio: 'xMidYMid meet' });
    let ang = -Math.PI / 2;
    values.forEach((v: number, i: number) => {
      const frac = Math.max(0, v) / total, a2 = ang + frac * 2 * Math.PI;
      const x1 = cx + r * Math.cos(ang), y1 = cy + r * Math.sin(ang);
      const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
      const large = frac > 0.5 ? 1 : 0;
      svg.appendChild(svgEl('path', { d: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`, fill: PAL[i % PAL.length] }));
      ang = a2;
      const ly = 34 + i * 21;
      svg.appendChild(svgEl('rect', { x: 200, y: ly - 10, width: 12, height: 12, rx: 2, fill: PAL[i % PAL.length] }));
      svg.appendChild(svgEl('text', { class: 'clbl', x: 219, y: ly }, `${labels[i]}  ${Math.round(frac * 100)}%`));
    });
    svg.appendChild(svgEl('circle', { class: 'chole', cx, cy, r: ir }));
    wrap.appendChild(svg);
    return wrap;
  }
  const W = 640, H = 260, padL = 44, padR = 16, padT = 16, padB = 34;
  const iw = W - padL - padR, ih = H - padT - padB;
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  const y = (v: number) => padT + ih - ((v - lo) / span) * ih;
  const wrap = document.createElement('div');
  wrap.className = 'chart';
  if (typeof spec.title === 'string' && spec.title) {
    const t = document.createElement('div'); t.className = 'ctitle'; t.textContent = spec.title; wrap.appendChild(t);
  }
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  // 0선/바닥 눈금
  svg.appendChild(svgEl('line', { class: 'cgrid', x1: padL, y1: y(0), x2: W - padR, y2: y(0) }));
  const n = values.length, slot = iw / n;
  values.forEach((v: number, i: number) => {
    const cx = padL + slot * (i + 0.5);
    if (type === 'bar') {
      const bw = Math.min(slot * 0.6, 48);
      const top = Math.min(y(v), y(0)), h = Math.abs(y(v) - y(0));
      svg.appendChild(svgEl('rect', { class: 'cbar', x: cx - bw / 2, y: top, width: bw, height: Math.max(1, h), rx: 3 }));
    }
    svg.appendChild(svgEl('text', { class: 'cval', x: cx, y: y(v) - 5, 'text-anchor': 'middle' }, String(v) + unit));
    svg.appendChild(svgEl('text', { class: 'clbl', x: cx, y: H - 12, 'text-anchor': 'middle' }, labels[i]));
  });
  if (type === 'line') {
    const pts = values.map((v: number, i: number) => `${padL + slot * (i + 0.5)},${y(v)}`).join(' ');
    svg.appendChild(svgEl('polyline', { class: 'cline', points: pts }));
    values.forEach((v: number, i: number) => svg.appendChild(svgEl('circle', { class: 'cdot', cx: padL + slot * (i + 0.5), cy: y(v), r: 3 })));
  }
  wrap.appendChild(svg);
  return wrap;
}
function renderMarkdown(text: string): DocumentFragment {
  const root = document.createDocumentFragment();
  const segs = String(text).split('```'); // 짝수=본문, 홀수=코드블록
  segs.forEach((seg, idx) => {
    if (idx % 2 === 1) {
      const lang = (seg.match(/^([\w-]*)\n/) || [, ''])[1];
      const bodyText = seg.replace(/^[\w-]*\n/, '').replace(/\n$/, '');
      if (lang === 'chart') {
        const el = renderChart(bodyText);
        if (el) { root.appendChild(el); return; } // 파싱 실패면 아래 코드블록으로 폴백
      }
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = bodyText;
      pre.appendChild(code);
      root.appendChild(pre);
      return;
    }
    let chunk = '';
    let list: HTMLElement | null = null; // 진행 중인 ul/ol
    const flushChunk = () => {
      if (chunk) { root.appendChild(mdInline(chunk.replace(/\n+$/, '\n').replace(/^\n+/, ''))); chunk = ''; }
    };
    const flushList = () => { list = null; };
    const lines = seg.split('\n');
    const isTableSep = (s: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(s) && s.includes('-');
    const cells = (row: string) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      // 표: 헤더행(| 포함) + 다음 줄이 구분선이면 비교 테이블로. 셀의 +/▲=초록, -/▼=빨강.
      if (line.includes('|') && li + 1 < lines.length && isTableSep(lines[li + 1])) {
        flushChunk(); flushList();
        const table = document.createElement('table'); table.className = 'cmp';
        const thead = document.createElement('tr');
        cells(line).forEach((c) => { const th = document.createElement('th'); th.appendChild(mdInline(c)); thead.appendChild(th); });
        table.appendChild(thead);
        li += 2; // 헤더+구분선 소비
        for (; li < lines.length && lines[li].includes('|'); li++) {
          const tr = document.createElement('tr');
          cells(lines[li]).forEach((c) => {
            const td = document.createElement('td');
            if (/^(▲|△|🔺|\+\s?[\d.])/.test(c)) td.className = 'up';
            else if (/^(▼|▽|🔻|-\s?[\d.])/.test(c)) td.className = 'down';
            td.appendChild(mdInline(c));
            tr.appendChild(td);
          });
          table.appendChild(tr);
        }
        li--; // for 증가분 보정
        root.appendChild(table);
        continue;
      }
      const h = line.match(/^(#{1,3})\s+(.*)/);
      const ul = line.match(/^\s*[-*]\s+(.*)/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      const cb = ul ? ul[1].match(/^\[([ xX])\]\s+(.*)/) : null; // 체크리스트 항목
      if (h) {
        flushChunk(); flushList();
        const d = document.createElement('div');
        d.className = 'mdh';
        d.appendChild(mdInline(h[2]));
        root.appendChild(d);
      } else if (ul || ol) {
        flushChunk();
        const kind = cb ? 'check' : (ul ? 'ul' : 'ol');
        if (!list || list.dataset.kind !== kind) {
          list = document.createElement(ol ? 'ol' : 'ul');
          if (cb) list.className = 'check';
          list.dataset.kind = kind;
          root.appendChild(list);
        }
        const item = document.createElement('li');
        if (cb) {
          const box = document.createElement('input'); box.type = 'checkbox'; box.disabled = true; box.checked = /[xX]/.test(cb[1]);
          const span = document.createElement('span'); span.appendChild(mdInline(cb[2]));
          item.appendChild(box); item.appendChild(span);
        } else {
          item.appendChild(mdInline((ul || ol)![1]));
        }
        list.appendChild(item);
      } else {
        flushList();
        chunk += line + '\n';
      }
    }
    flushChunk();
  });
  return root;
}

export { renderMarkdown, renderChart, mdInline };
