# 올라마 다중 두뇌 등록 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설정창에서 올라마 모델별 두뇌를 이름을 달리해 여러 개 등록/삭제할 수 있게 한다 (현재는 고정 이름 `'ollama'` 하나가 덮어써짐).

**Architecture:** 데스크톱 순수 함수 2개(`slugFromModel`·`removeBrainProfile`)를 brains-file.ts에 추가하고, `addOllamaProfile`에 이름 인자를 넣고, IPC 3건(add-ollama 3인자·remove-brain·slug-model)을 지나 settings.html의 두뇌 섹션 UI(이름 입력란·등록 목록·삭제)로 노출한다. 서버(src/agent-layer, src/brain, src/edge) 무변경.

**Tech Stack:** Electron(main/preload/설정창 인라인 JS), TypeScript, Jest. 스펙: `docs/superpowers/specs/2026-07-17-multi-ollama-brains-design.md`

## Global Constraints

- 이 머신은 Bash 도구가 깨져 있음 — 모든 명령은 **PowerShell**로. jest를 백그라운드로 돌리지 말 것(행 걸림 관찰됨), 포그라운드로 실행.
- 테스트 실행: `npm test -- --testPathPattern="desktop"` (백엔드 jest). 전체는 `npm test`.
- UI 문구는 **영어 기본 + ko 로케일 한국어** (settings.html의 `t` 객체 두 벌).
- 렌더러 유래 문자열은 전부 `textContent`로만 DOM에 넣기 — innerHTML 금지 (기존 주석 규칙).
- 커밋 메시지에 Co-Authored-By 넣지 않기 (사용자 지침).
- 서버 코드(src/agent-layer, src/brain, src/edge) 및 기존 함수(`mergeBrainProfile`·`listBrains`·`setDefaultBrain`) 무변경.

---

### Task 1: brains-file.ts — slugFromModel + removeBrainProfile

**Files:**
- Modify: `src/desktop/brains-file.ts`
- Test: `src/desktop/brains-file.spec.ts`

**Interfaces:**
- Consumes: 기존 brains.json 스키마 `{ default: string, brains: Record<string, object> }`.
- Produces: `slugFromModel(model: string): string`, `removeBrainProfile(configDir: string, key: string): void` — Task 2·3이 이 시그니처 그대로 import.

- [ ] **Step 1: 실패하는 테스트 작성** — `src/desktop/brains-file.spec.ts` 끝에 추가:

```typescript
import { mergeBrainProfile, listBrains, setDefaultBrain, slugFromModel, removeBrainProfile } from './brains-file';
// (기존 import 줄에 slugFromModel, removeBrainProfile만 추가)

describe('slugFromModel', () => {
  it('콜론을 -로: qwen3:8b → qwen3-8b', () => {
    expect(slugFromModel('qwen3:8b')).toBe('qwen3-8b');
  });
  it('슬래시·점 등 영숫자 외 문자 전부 -로, 소문자화, 연속 - 축약', () => {
    expect(slugFromModel('hf.co/Org/Model.Q4_K_M')).toBe('hf-co-org-model-q4_k_m');
  });
  it('양끝 - 제거', () => {
    expect(slugFromModel(':qwen:')).toBe('qwen');
  });
  it('빈 결과면 ollama 폴백', () => {
    expect(slugFromModel('::')).toBe('ollama');
    expect(slugFromModel('')).toBe('ollama');
  });
});

describe('removeBrainProfile', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-brains-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const file = () => path.join(tmp, 'brains.json');
  const read = () => JSON.parse(fs.readFileSync(file(), 'utf8'));

  it('기본이 아닌 프로필을 지운다(나머지 보존)', () => {
    fs.writeFileSync(file(), JSON.stringify({ default: 'claude', brains: { claude: {}, gemma: { model: 'gemma4:e4b' } } }));
    removeBrainProfile(tmp, 'gemma');
    expect(read()).toEqual({ default: 'claude', brains: { claude: {} } });
  });
  it('default 프로필이면 no-op(서버 기동 안전선)', () => {
    fs.writeFileSync(file(), JSON.stringify({ default: 'claude', brains: { claude: {}, gemma: {} } }));
    removeBrainProfile(tmp, 'claude');
    expect(read().brains.claude).toEqual({});
  });
  it('없는 key·파일 없음·깨진 파일 전부 no-op', () => {
    expect(() => removeBrainProfile(tmp, 'ghost')).not.toThrow();
    fs.writeFileSync(file(), JSON.stringify({ default: 'claude', brains: { claude: {} } }));
    removeBrainProfile(tmp, 'ghost');
    expect(read().brains.claude).toEqual({});
    fs.writeFileSync(file(), '{깨진');
    expect(() => removeBrainProfile(tmp, 'claude')).not.toThrow();
    expect(fs.readFileSync(file(), 'utf8')).toBe('{깨진');
  });
});
```

주의: 이 spec 파일 상단에 `fs`/`os`/`path` import가 이미 있는지 확인하고 없으면 추가 (`import * as fs from 'fs'` 등, ollama.spec.ts와 동일 스타일).

- [ ] **Step 2: 실패 확인**

Run: `npm test -- --testPathPattern="brains-file"`
Expected: FAIL — `slugFromModel`/`removeBrainProfile` export 없음.

- [ ] **Step 3: 최소 구현** — `src/desktop/brains-file.ts` 끝에 추가:

```typescript
// 모델명 → 두뇌 이름 제안 (qwen3:8b → qwen3-8b). 위임 때 채팅에서 이름으로 부르므로 부르기 쉬운 형태.
export function slugFromModel(model: string): string {
  const s = model.toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'ollama';
}

// 프로필 삭제. default면 no-op — 기본 두뇌가 사라지면 서버가 시작을 못 하므로 파일 계층이 최종 안전선.
export function removeBrainProfile(configDir: string, key: string): void {
  const file = path.join(configDir, 'brains.json');
  let raw: { default?: string; brains?: Record<string, unknown> };
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!raw || typeof raw !== 'object' || !raw.brains || typeof raw.brains !== 'object') return;
  if (raw.default === key) return;
  if (!(key in raw.brains)) return;
  delete raw.brains[key];
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- --testPathPattern="brains-file"`
Expected: PASS (기존 mergeBrainProfile/listBrains/setDefaultBrain 테스트 포함 전부).

- [ ] **Step 5: 커밋**

```powershell
git add src/desktop/brains-file.ts src/desktop/brains-file.spec.ts
git commit -m "feat(multi-brains): slugFromModel·removeBrainProfile — 이름 제안+프로필 삭제(default 보호)"
```

---

### Task 2: ollama.ts — addOllamaProfile에 이름 인자

**Files:**
- Modify: `src/desktop/ollama.ts:22-28`
- Test: `src/desktop/ollama.spec.ts` (기존 describe 수정 + 회귀 테스트 추가)

**Interfaces:**
- Consumes: Task 1과 무관 (mergeBrainProfile 그대로 사용).
- Produces: `addOllamaProfile(configDir: string, model: string, name: string, setDefault?: boolean): void` — Task 3의 IPC가 이 시그니처로 호출.

- [ ] **Step 1: 테스트 수정·추가** — `src/desktop/ollama.spec.ts`의 `describe('addOllamaProfile')`에서 기존 호출 4곳에 3번째 인자 `'ollama'`를 넣고 (`addOllamaProfile(tmp, 'llama3.3:latest', 'ollama')` / `addOllamaProfile(tmp, 'qwen3:8b', 'ollama')` / `addOllamaProfile(tmp, 'qwen3:8b', 'ollama', true)` — setDefault는 4번째로 이동), 회귀 테스트 추가:

```typescript
  it('서로 다른 이름으로 두 모델을 등록하면 둘 다 남는다(이번 작업의 존재 이유)', () => {
    addOllamaProfile(tmp, 'qwen3:8b', 'qwen3-8b');
    addOllamaProfile(tmp, 'gemma4:e4b', 'gemma4-e4b');
    const cfg = readBrains();
    expect(cfg.brains['qwen3-8b'].model).toBe('qwen3:8b');
    expect(cfg.brains['gemma4-e4b'].model).toBe('gemma4:e4b');
  });
```

주의: 기존 테스트 중 `cfg.brains.ollama`를 읽는 단언은 3번째 인자를 `'ollama'`로 넘기므로 그대로 성립한다.

- [ ] **Step 2: 실패 확인**

Run: `npm test -- --testPathPattern="ollama"`
Expected: FAIL — 3번째 인자(name) 자리에 boolean/undefined가 들어가 프로필 이름이 어긋남 (TS 컴파일 에러 또는 단언 실패).

- [ ] **Step 3: 구현** — `src/desktop/ollama.ts`의 `addOllamaProfile`을 교체:

```typescript
export function addOllamaProfile(configDir: string, model: string, name: string, setDefault = false): void {
  mergeBrainProfile(configDir, name, {
    provider: 'openai-api',
    baseUrl: `${OLLAMA_URL}/v1`,
    model,
  }, setDefault);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- --testPathPattern="ollama"`
Expected: PASS. 이어서 `npm run build` — 컴파일 에러로 다른 호출부(main.ts)가 잡히면 Task 3에서 고치므로, 여기서는 main.ts의 `addOllamaProfile(configDir, model, setDefault)` 호출을 임시로 두지 말고 **Task 3과 같은 커밋 흐름이 되도록 main.ts 호출부도 이 태스크에서 함께 수정**:

`src/desktop/main.ts:226-228`을 다음으로 교체 (원래 Task 3 영역이지만 컴파일을 깨뜨리지 않기 위해 여기서 시그니처만 맞춤):

```typescript
  ipcMain.handle('engram:add-ollama', (_e, model: string, name: string, setDefault: boolean) => {
    addOllamaProfile(configDir, model, name, setDefault);
  });
```

Run: `npm run build`
Expected: 컴파일 clean.

- [ ] **Step 5: 커밋**

```powershell
git add src/desktop/ollama.ts src/desktop/ollama.spec.ts src/desktop/main.ts
git commit -m "feat(multi-brains): addOllamaProfile 이름 인자 — 고정 'ollama' 덮어쓰기 제거, 다중 등록 가능"
```

---

### Task 3: IPC + preload — remove-brain·slug-model 노출

**Files:**
- Modify: `src/desktop/main.ts` (registerIpc 안, `engram:set-default-brain` 줄 아래)
- Modify: `src/desktop/preload.ts`

**Interfaces:**
- Consumes: Task 1의 `removeBrainProfile(configDir, key)`·`slugFromModel(model)`, Task 2에서 이미 3인자로 맞춘 `engram:add-ollama`.
- Produces: 렌더러 전역 `window.engram`에 `addOllama(model, name, setDefault)`, `removeBrain(key)`, `slugModel(model)` — Task 4의 settings.html이 이 이름들로 호출.

- [ ] **Step 1: main.ts에 핸들러 추가** — `ipcMain.handle('engram:set-default-brain', …)` 줄(현재 236행) 바로 아래에:

```typescript
  ipcMain.handle('engram:remove-brain', (_e, key: string) => { removeBrainProfile(configDir, key); });
  ipcMain.handle('engram:slug-model', (_e, model: string) => slugFromModel(model));
```

main.ts 상단의 brains-file import에 두 함수 추가 (기존 `import { listBrains, setDefaultBrain, mergeBrainProfile … } from './brains-file'` 형태의 줄에 `removeBrainProfile, slugFromModel` 병기 — 실제 import 줄은 파일 상단에서 확인).

- [ ] **Step 2: preload.ts 갱신** — `addOllama` 교체 + 2건 추가:

```typescript
  addOllama: (model: string, name: string, setDefault: boolean) =>
    ipcRenderer.invoke('engram:add-ollama', model, name, setDefault),
  removeBrain: (key: string) => ipcRenderer.invoke('engram:remove-brain', key),
  slugModel: (model: string) => ipcRenderer.invoke('engram:slug-model', model),
```

- [ ] **Step 3: 검증** — 이 태스크는 얇은 위임이라 유닛 테스트 없음(기존 IPC들과 동일 취급).

Run: `npm run build`
Expected: 컴파일 clean.

Run: `npm test -- --testPathPattern="desktop"`
Expected: PASS (desktop 스펙 전부).

- [ ] **Step 4: 커밋**

```powershell
git add src/desktop/main.ts src/desktop/preload.ts
git commit -m "feat(multi-brains): IPC remove-brain·slug-model + preload 노출"
```

---

### Task 4: settings.html — 이름 입력란·등록 목록·삭제 UI + i18n

**Files:**
- Modify: `src/desktop/settings.html` (HTML 두뇌 섹션 + 인라인 스크립트 + i18n `t` 두 벌)

**Interfaces:**
- Consumes: `window.engram.addOllama(model, name, setDefault)`, `removeBrain(key)`, `slugModel(model)`, `listBrains()` → `[{ key, provider, model, isDefault }]`.
- Produces: 최종 사용자 UI. 이후 태스크 없음.

- [ ] **Step 1: HTML 수정** — `#ollama-add` 행(174-178행)을 다음으로 교체 (select 뒤에 이름 입력란, 밑에 힌트):

```html
    <div class="row" id="ollama-add" hidden>
      <select id="ollama-model"></select>
      <input id="ollama-name" class="mono" style="width:150px" />
      <label style="font-size:13px"><input type="checkbox" id="ollama-default" /> <span data-t="setDefault"></span></label>
      <button class="primary" id="btn-ollama" data-t="addBrain"></button>
    </div>
    <div class="hint" id="ollama-name-hint" hidden></div>
```

그리고 `#default-brain-row` 위(184행 앞)에 등록 목록 컨테이너:

```html
    <div id="brain-list" style="margin-top:14px" hidden></div>
```

- [ ] **Step 2: 스타일 추가** — `<style>` 안 `.hint` 규칙 아래에:

```css
    .brain-row { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; margin-top: 6px; font-size: 13px; }
    .brain-row .meta2 { color: var(--muted); font-size: 12px; }
    .brain-row .badge { margin-left: auto; background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); font-size: 11px; padding: 2px 8px; border-radius: 20px; }
    .brain-row button { padding: 4px 10px; font-size: 12px; }
    .brain-row button:disabled { opacity: 0.4; cursor: default; }
    .brain-row button:disabled:hover { border-color: var(--line); }
```

(주의: `.badge`가 없는 줄은 삭제 버튼을 `margin-left:auto`로 밀어야 함 — 아래 스크립트에서 badge 없을 때 버튼에 `style.marginLeft='auto'` 지정.)

- [ ] **Step 3: i18n 문구 추가** — `t` 객체 두 벌에 각각:

ko 쪽 (`cmdHint: …` 줄 뒤):

```javascript
      namePlaceholder: '두뇌 이름', nameHint: '채팅에서 이 이름으로 부릅니다 — 예: "qwen3-8b한테 물어봐"',
      overwrite: '덮어쓰기', del: '삭제', defaultBadge: '기본',
      defaultLocked: '기본 두뇌는 먼저 다른 두뇌를 기본으로 지정한 뒤 삭제할 수 있어요',
```

en 쪽 (`cmdHint: …` 줄 뒤):

```javascript
      namePlaceholder: 'Brain name', nameHint: 'This is how you call it in chat — e.g. "ask qwen3-8b"',
      overwrite: 'Overwrite', del: 'Delete', defaultBadge: 'default',
      defaultLocked: 'Set another brain as default first',
```

- [ ] **Step 4: 스크립트 배선** — 인라인 스크립트 수정 4곳:

(a) `detect()` 안 올라마 성공 분기 — select 채운 뒤(358행 `$('ollama-add').hidden = …` 앞)에 이름 자동 채움 + 힌트 표시:

```javascript
        $('ollama-name').placeholder = t.namePlaceholder;
        if (o.models.length && !nameDirty) {
          $('ollama-name').value = await window.engram.slugModel(sel.value);
        }
        $('ollama-name-hint').textContent = t.nameHint;
        $('ollama-name-hint').hidden = o.models.length === 0;
        updateAddButton();
```

실패 분기(`else`)에는 `$('ollama-name-hint').hidden = true;` 추가.

(b) dirty 플래그 + 모델 변경·이름 입력 핸들러 + 추가 버튼 라벨 — `$('btn-ollama').onclick` 근처에:

```javascript
    let nameDirty = false;
    let brainKeys = [];
    function updateAddButton() {
      const name = $('ollama-name').value.trim();
      $('btn-ollama').disabled = !name;
      $('btn-ollama').textContent = brainKeys.includes(name) ? t.overwrite : t.addBrain;
    }
    $('ollama-name').oninput = () => { nameDirty = true; updateAddButton(); };
    $('ollama-model').onchange = async () => {
      if (!nameDirty) $('ollama-name').value = await window.engram.slugModel($('ollama-model').value);
      updateAddButton();
    };
```

(c) `$('btn-ollama').onclick` 교체:

```javascript
    $('btn-ollama').onclick = async () => {
      const name = $('ollama-name').value.trim();
      if (!name) return;
      await window.engram.addOllama($('ollama-model').value, name, $('ollama-default').checked);
      setLine($('ollama'), [{ cls: 'ok', text: t.added }]);
      nameDirty = false;
      await loadBrains();
    };
```

(d) `loadBrains()` 확장 — 기존 드롭다운 채우기 유지, 끝(406행 `$('default-brain-row').hidden = …` 앞)에 목록 렌더 + brainKeys 갱신:

```javascript
      brainKeys = brains.map((b) => b.key);
      const list = $('brain-list');
      list.textContent = '';
      for (const b of brains) {
        const row = document.createElement('div');
        row.className = 'brain-row';
        const name = document.createElement('span');
        name.className = 'mono';
        name.textContent = b.key;
        const meta = document.createElement('span');
        meta.className = 'meta2';
        meta.textContent = b.model ? `${b.provider} · ${b.model}` : b.provider;
        row.append(name, meta);
        if (b.isDefault) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = t.defaultBadge;
          row.appendChild(badge);
        }
        const del = document.createElement('button');
        del.textContent = t.del;
        if (!b.isDefault) del.style.marginLeft = 'auto';
        if (b.isDefault) { del.disabled = true; del.title = t.defaultLocked; }
        else del.onclick = async () => { await window.engram.removeBrain(b.key); await loadBrains(); };
        row.appendChild(del);
        list.appendChild(row);
      }
      list.hidden = brains.length === 0;
      updateAddButton();
```

`$('default-brain').onchange` 핸들러는 기본 변경 후 목록의 badge·삭제버튼 상태도 갱신해야 하므로 교체:

```javascript
    $('default-brain').onchange = async () => {
      await window.engram.setDefaultBrain($('default-brain').value);
      await loadBrains();
    };
```

주의: `updateAddButton`·`nameDirty`·`brainKeys` 선언은 `detect()`·`loadBrains()`보다 **위**에 있어야 함 (호이스팅되지 않는 `let`). 스크립트 상단 `const $ = …` 근처에 배치.

- [ ] **Step 5: 검증** — settings.html은 테스트 하네스가 없으므로(인라인 스크립트) 빌드·전체 회귀로 확인:

Run: `npm run build`
Expected: clean.

Run: `npm test`
Expected: 전부 PASS (백엔드 867+ 유지, 이번 추가분 포함).

수동 스모크(가능하면): 앱 실행 → 설정 → 모델 선택 시 이름 자동 채움 → 다른 이름으로 2개 추가 → 목록에 2줄 → 기본 두뇌 줄 삭제 비활성 → 다른 줄 삭제 동작 → 기본 두뇌 드롭다운 변경 시 badge 이동. 앱 실행이 불가한 환경이면 "수동 스모크 미검증"으로 보고.

- [ ] **Step 6: 커밋**

```powershell
git add src/desktop/settings.html
git commit -m "feat(multi-brains): 설정창 — 이름 입력(자동제안+수정)·등록 목록·삭제 UI, 기본 두뇌 삭제 보호"
```

---

## Self-Review 결과

- 스펙 §3.1→Task 1, §3.2→Task 2, §3.3→Task 2(호출부)+Task 3, §3.4→Task 4, §3.5(삭제 정책)→Task 1(default no-op)+Task 4(비활성 버튼). §4 테스트 전부 Task 1·2에 코드로 존재. 커버리지 갭 없음.
- 시그니처 일관성: `addOllamaProfile(configDir, model, name, setDefault)` / `removeBrainProfile(configDir, key)` / `slugFromModel(model)` / preload `addOllama(model, name, setDefault)`·`removeBrain(key)`·`slugModel(model)` — Task 간 동일 확인.
- Task 2가 main.ts 호출부를 함께 고치는 것은 컴파일 그린 유지를 위한 의도적 결정(각 커밋이 빌드 가능해야 함).
