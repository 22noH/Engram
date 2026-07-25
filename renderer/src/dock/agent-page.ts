// 페이지 안에서 도는 코드(문자열) — <webview>.executeJavaScript로 주입된다.
//
// 왜 문자열인가: 게스트 페이지는 앱과 완전히 다른 프로세스·컨텍스트다. 렌더러의 함수를 넘길 수
// 없어서 "이 코드를 거기서 실행해줘"가 유일한 길이다. 대신 파라미터는 전부 JSON.stringify로
// 실어 보낸다(문자열 이어붙이기로 만든 코드에 사용자 입력이 섞이면 그 자체가 주입 구멍이다).
//
// 반환값은 반드시 JSON 직렬화 가능해야 한다(executeJavaScript 계약).
// 각 스크립트는 자기완결 IIFE라 jsdom에서 eval로 그대로 테스트할 수 있다(agent-page.test.ts).

/** 요소를 찾는 공통 조각. `text=보이는 글자`와 CSS 선택자를 모두 받는다. */
const FIND_FN = `
  function __engramFind(target) {
    if (typeof target !== 'string' || !target) return null;
    if (target.slice(0, 5) === 'text=') {
      var want = target.slice(5).trim().toLowerCase();
      var cands = document.querySelectorAll('button, a, [role="button"], input, label, summary, [onclick], li, td, span, div');
      var best = null;
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        var t = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
        if (!t) continue;
        if (t === want) return el;
        if (!best && t.indexOf(want) !== -1 && t.length < want.length + 60) best = el;
      }
      return best;
    }
    try { return document.querySelector(target); } catch (e) { return null; }
  }
  // "보이는가" 판정은 크기가 아니라 **숨김 여부**로 한다: getBoundingClientRect는 레이아웃이
  // 아직 안 잡힌 순간(방금 그린 요소·가상 스크롤)에도 0이라 멀쩡한 버튼을 못 누르는 오진을 낸다.
  function __engramVisible(el) {
    if (!el) return false;
    try {
      var st = window.getComputedStyle(el);
      if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
    } catch (e) { /* 스타일 조회 실패는 보이는 것으로 본다 */ }
    if (el.hasAttribute && el.hasAttribute('hidden')) return false;
    if (el.type === 'hidden') return false;
    return true;
  }
  function __engramSelector(el) {
    if (!el) return '';
    if (el.id) return '#' + el.id;
    var name = el.getAttribute && el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
    var parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();
    var same = [];
    for (var i = 0; i < parent.children.length; i++) {
      if (parent.children[i].tagName === el.tagName) same.push(parent.children[i]);
    }
    var idx = same.indexOf(el) + 1;
    return el.tagName.toLowerCase() + (same.length > 1 ? ':nth-of-type(' + idx + ')' : '');
  }
`;

/** 조작 중인 요소를 화면에 표시(테두리+라벨). 사용자가 "지금 뭘 건드리는지" 보게 하는 장치. */
const HIGHLIGHT_FN = `
  function __engramHighlight(el, label) {
    try {
      if (!el || !el.getBoundingClientRect) return;
      var r = el.getBoundingClientRect();
      var box = document.createElement('div');
      box.setAttribute('data-engram-highlight', '1');
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2e6e63;' +
        'border-radius:5px;box-shadow:0 0 0 9999px rgba(0,0,0,0);transition:opacity .3s;' +
        'left:' + (r.left - 2) + 'px;top:' + (r.top - 2) + 'px;width:' + r.width + 'px;height:' + r.height + 'px;';
      var tag = document.createElement('div');
      tag.textContent = label;
      tag.style.cssText = 'position:absolute;top:-19px;left:-2px;background:#2e6e63;color:#fff;font:10px/1.6 ' +
        'system-ui,sans-serif;padding:1px 6px;border-radius:4px;white-space:nowrap;';
      box.appendChild(tag);
      document.body.appendChild(box);
      setTimeout(function () { box.style.opacity = '0'; }, 900);
      setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 1400);
    } catch (e) { /* 표시 실패가 조작을 막지 않는다 */ }
  }
`;

function wrap(body: string): string {
  return `(function(){${FIND_FN}${HIGHLIGHT_FN}try{${body}}catch(e){return {ok:false,error:String(e && e.message || e)};}})()`;
}

/** 입력 대상 칸의 정체 조회 — 로그인·결제 판정 재료를 페이지에서 뽑아온다(판정은 앱에서). */
export function inspectScript(target: string): string {
  return wrap(`
    var el = __engramFind(${JSON.stringify(target)});
    if (!el) return { ok: false, error: 'not-found' };
    var tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && el.isContentEditable !== true) {
      return { ok: false, error: 'not-editable', tag: tag };
    }
    var label = '';
    try {
      if (el.labels && el.labels.length) label = el.labels[0].innerText || el.labels[0].textContent || '';
      if (!label && el.getAttribute('aria-label')) label = el.getAttribute('aria-label');
      if (!label && el.closest) {
        var lb = el.closest('label');
        if (lb) label = lb.innerText || lb.textContent || '';
      }
    } catch (e) { /* 라벨 조회 실패는 무시 */ }
    return {
      ok: true,
      field: {
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        id: el.id || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        placeholder: el.getAttribute('placeholder') || '',
        label: String(label).trim().slice(0, 120),
      },
      selector: __engramSelector(el),
    };
  `);
}

export function clickScript(target: string, label: string): string {
  return wrap(`
    var el = __engramFind(${JSON.stringify(target)});
    if (!el) return { ok: false, error: 'not-found' };
    if (!__engramVisible(el)) return { ok: false, error: 'not-visible' };
    __engramHighlight(el, ${JSON.stringify(label)});
    var name = (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).toString().trim().slice(0, 60);
    if (el.scrollIntoView) { try { el.scrollIntoView({ block: 'center' }); } catch (e) { el.scrollIntoView(); } }
    if (el.focus) el.focus();
    el.click();
    return { ok: true, name: name, selector: __engramSelector(el) };
  `);
}

/**
 * 값 입력 — React 등 프레임워크가 붙은 칸도 실제로 바뀌게 네이티브 setter로 넣고 input/change를 쏜다.
 * (el.value = x 만 하면 React의 내부 상태가 안 따라와 "쳤는데 안 먹는" 오진이 난다.)
 */
export function typeScript(target: string, text: string, submit: boolean, label: string): string {
  return wrap(`
    var el = __engramFind(${JSON.stringify(target)});
    if (!el) return { ok: false, error: 'not-found' };
    __engramHighlight(el, ${JSON.stringify(label)});
    if (el.scrollIntoView) { try { el.scrollIntoView({ block: 'center' }); } catch (e) { el.scrollIntoView(); } }
    if (el.focus) el.focus();
    var value = ${JSON.stringify(text)};
    if (el.isContentEditable === true) {
      el.textContent = value;
    } else {
      var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (${submit ? 'true' : 'false'}) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      if (el.form && el.form.requestSubmit) { try { el.form.requestSubmit(); } catch (e) { /* 무시 */ } }
    }
    return { ok: true, selector: __engramSelector(el) };
  `);
}

/** 화면 내용 + 조작 가능한 요소 목록(선택자 포함) — 모델이 추측 대신 실제 요소를 찍게 한다. */
export function readScript(selector: string | undefined, maxChars: number, maxElements: number): string {
  return wrap(`
    var root = ${selector ? `__engramFind(${JSON.stringify(selector)})` : 'document.body'};
    if (!root) return { ok: false, error: 'not-found' };
    var text = (root.innerText || root.textContent || '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
    var truncated = text.length > ${maxChars};
    var els = [];
    var nodes = root.querySelectorAll('a, button, input, textarea, select, [role="button"]');
    for (var i = 0; i < nodes.length && els.length < ${maxElements}; i++) {
      var el = nodes[i];
      if (!__engramVisible(el)) continue;
      var kind = el.tagName.toLowerCase();
      var type = el.getAttribute('type');
      var name = (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '')
        .toString().trim().replace(/\\s+/g, ' ').slice(0, 60);
      els.push({ kind: kind + (type ? '[' + type + ']' : ''), name: name, selector: __engramSelector(el) });
    }
    return {
      ok: true,
      url: location.href,
      title: document.title,
      text: truncated ? text.slice(0, ${maxChars}) + '\\n…(truncated)' : text,
      elements: els,
    };
  `);
}

/** 네트워크 — 별도 후킹 없이 표준 Resource Timing으로 본다(주입 스크립트가 페이지를 안 건드린다). */
export function networkScript(max: number): string {
  return wrap(`
    var out = [];
    var list = (performance.getEntriesByType && performance.getEntriesByType('resource')) || [];
    for (var i = Math.max(0, list.length - ${max}); i < list.length; i++) {
      var e = list[i];
      out.push({
        url: String(e.name).slice(0, 200),
        kind: e.initiatorType || '',
        ms: Math.round(e.duration),
        bytes: e.transferSize || 0,
      });
    }
    return { ok: true, requests: out, total: list.length };
  `);
}
