import { useEffect, useState } from 'react';
import { T } from '../i18n';
import {
  fetchModels, addOllamaModel, saveModelApiKey, setDefaultModel, deleteModel, fetchMembers,
  type ModelsData, type MemberDto,
} from '../api';
import { Nav, type NavKey } from '../components/Nav';

// ⑥ 모델 — 목업 픽셀 그대로, 단 API 계약 밖 요소는 뺐다(report 참조):
//  · 하네스 select는 데스크톱 설정창(b221e2d)과 같은 문법으로 클라이언트 사이드 필터다 — provider가
//    /^(anthropic|openai)-api$/면 'engram', 아니면 'cli'(admin-http.ts listModels 산정과 동일 규칙).
//    선택을 바꾸면 기본 모델 select가 그 하네스의 모델만 보여준다. 그 하네스에 모델이 하나도 없으면
//    안내 문구만 띄우고 기본 모델은 그대로 둔다(desktop b221e2d 빈 하네스 처리와 동일).
//  · 행별 "편집" 버튼은 없앴다(PATCH /models/:key 자체가 없음). 기본 모델 행은 "삭제" 대신
//    비활성 삭제 버튼+툴팁("먼저 다른 모델을 기본으로")으로 목업의 "삭제 불가 안내"를 표현한다.
//  · "로컬 모델" 추가 행은 목업의 select(로컬 Ollama 모델 목록)가 아니라 텍스트 입력이다 —
//    이 API 표면엔 Ollama 모델 나열 엔드포인트가 없다.
//  · 목록 행 설명줄은 baseUrl(목업 "localhost:11434")을 안 보여준다 — GET 응답에 그 필드가 없음.

// provider → 하네스(admin-http.ts listModels와 동일 규칙, 클라이언트에서 재계산).
function harnessOf(provider: string): 'cli' | 'engram' {
  return /^(anthropic|openai)-api$/.test(provider) ? 'engram' : 'cli';
}

export function Models({ serverName, role, active, onNavigate }: {
  serverName: string; role: string; active: NavKey; onNavigate: (k: NavKey) => void;
}) {
  const [data, setData] = useState<ModelsData | null>(null);
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [ollamaModel, setOllamaModel] = useState('');
  const [ollamaName, setOllamaName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [harness, setHarness] = useState<'cli' | 'engram'>('cli');
  const [harnessInit, setHarnessInit] = useState(false);

  const load = () => {
    fetchModels().then((d) => {
      setData(d);
      // 하네스 선택은 최초 로드 때만 API 값으로 초기화한다 — 이후 재조회(모델 추가·삭제·기본 변경)에
      // 사용자가 고른 필터를 되돌리지 않는다.
      if (d && !harnessInit) { setHarness(d.harness); setHarnessInit(true); }
    });
    fetchMembers().then(setMembers);
  };
  useEffect(load, []);

  const harnessModels = (data?.models ?? []).filter((d) => harnessOf(d.provider) === harness);

  const changeDefault = async (key: string) => {
    if (!key) return;
    await setDefaultModel(key);
    load();
  };

  const submitOllama = async () => {
    if (!ollamaModel.trim() || !ollamaName.trim()) return;
    setBusy(true);
    const ok = await addOllamaModel(ollamaModel, ollamaName);
    setBusy(false);
    if (ok) { setOllamaModel(''); setOllamaName(''); load(); }
  };

  const submitApiKey = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    const ok = await saveModelApiKey(apiKey);
    setBusy(false);
    setApiKey(''); // 성공·실패 무관 입력칸은 비운다 — 원문을 화면에 남기지 않는다(보안 요구).
    if (ok) load();
  };

  const removeModel = async (key: string) => {
    await deleteModel(key);
    load();
  };

  const pendingMembers = (members ?? []).filter((m) => m.status === 'pending').length;

  return (
    <div className="page">
      <div className="frame">
        <Nav serverName={serverName} address={window.location.host} active={active} onNavigate={onNavigate}
             pendingMembers={pendingMembers} role={role} />
        <div className="main">
          <h2>{T.modelsTitle}</h2>
          <div className="sub">{T.modelsSub}</div>

          <div className="grp form">
            <div className="frow">
              <label>{T.harnessLabel}</label>
              <select value={harness} style={{ maxWidth: 220 }}
                      onChange={(e) => setHarness(e.target.value as 'cli' | 'engram')}>
                <option value="engram">{T.harnessEngram}</option>
                <option value="cli">{T.harnessCli}</option>
              </select>
            </div>
            <div className="frow">
              <label>{T.defaultModelLabel}</label>
              <select value={data?.default ?? ''} style={{ maxWidth: 220 }}
                      onChange={(e) => changeDefault(e.target.value)}>
                {harnessModels.map((d) => (
                  <option key={d.key} value={d.key}>{d.key}{d.model && d.model !== d.key ? ` · ${d.model}` : ''}</option>
                ))}
              </select>
            </div>
            {data && harnessModels.length === 0 && (
              <div className="frow">
                <label></label>
                <span className="hint">{T.harnessEmptyHint}</span>
              </div>
            )}
          </div>

          <div className="grp-h">{T.registeredModelsHeading}</div>
          <div className="grp">
            {(data?.models ?? []).map((d) => (
              <div className="row" key={d.key}>
                <div className="who">
                  <div className="n">{d.key}</div>
                  <div className="id">
                    {d.provider}{d.model ? ` · ${d.model}` : ''}{d.hasApiKey ? ` · ${T.apiKeySetLabel}` : ''}
                  </div>
                </div>
                {d.isDefault
                  ? <span className="chip owner">{T.defaultBadge}</span>
                  : <span className="chip">{T.activeChip}</span>}
                <div className="btns">
                  <button className="danger" disabled={d.isDefault}
                          title={d.isDefault ? T.deleteDefaultHint : undefined}
                          onClick={() => removeModel(d.key)}>{T.deleteBtn}</button>
                </div>
              </div>
            ))}
          </div>

          <div className="grp-h">{T.addHeading}</div>
          <div className="grp form">
            <div className="frow">
              <label>{T.localModelLabel}</label>
              <input value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)}
                     placeholder="qwen3:8b" style={{ maxWidth: 200 }} />
              <input value={ollamaName} onChange={(e) => setOllamaName(e.target.value)}
                     placeholder={T.modelNamePlaceholder} style={{ maxWidth: 150 }} />
              <button className="btn-accent compact" disabled={busy} onClick={submitOllama}>{T.addBtn}</button>
            </div>
            <div className="frow">
              <label>{T.anthropicApiKeyLabel}</label>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                     placeholder={T.apiKeyPlaceholder} style={{ maxWidth: 260 }} />
              <button className="btn-accent compact" disabled={busy} onClick={submitApiKey}>{T.save}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
