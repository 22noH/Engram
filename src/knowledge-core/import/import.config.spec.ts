import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_IMPORT_CONFIG, IMPORT_CONFIG_FILE, importLedgerPath, importTriggerPath,
  loadImportConfig, normalizeImportConfig, saveImportConfig, touchImportTrigger,
} from './import.config';

describe('폴더 자동 변환 설정', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-impcfg-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('없으면 안전한 기본값 — 꺼짐, 승인함으로, AI 정리', () => {
    const c = loadImportConfig(dir);
    expect(c.enabled).toBe(false);
    expect(c.publish).toBe('propose');
    expect(c.mode).toBe('ai');
    expect(c.folder).toBe('');
  });

  it('깨진 파일도 기본값으로 떨어진다(never-throw)', () => {
    fs.writeFileSync(path.join(dir, IMPORT_CONFIG_FILE), '{broken');
    expect(loadImportConfig(dir)).toEqual(DEFAULT_IMPORT_CONFIG);
  });

  it('저장하고 다시 읽는다', () => {
    saveImportConfig(dir, { enabled: true, folder: 'C:\\inbox', mode: 'raw', publish: 'direct' });
    expect(loadImportConfig(dir)).toMatchObject({ enabled: true, folder: 'C:\\inbox', mode: 'raw', publish: 'direct' });
  });

  it('부분 저장은 기존 값을 보존한다', () => {
    saveImportConfig(dir, { folder: 'C:\\inbox', maxFilesPerRun: 9 });
    saveImportConfig(dir, { enabled: true });
    expect(loadImportConfig(dir)).toMatchObject({ enabled: true, folder: 'C:\\inbox', maxFilesPerRun: 9 });
  });

  it('알 수 없는 값은 안전한 쪽으로 정규화한다', () => {
    const c = normalizeImportConfig({ enabled: 'yes', mode: 'weird', publish: 'nuke', folder: '  /a/b  ' });
    expect(c).toMatchObject({ enabled: false, mode: 'ai', publish: 'propose', folder: '/a/b' });
  });

  it('상한값은 범위 안으로 강제된다(비용 폭주 방지)', () => {
    expect(normalizeImportConfig({ maxFilesPerRun: 0 }).maxFilesPerRun).toBe(1);
    expect(normalizeImportConfig({ maxFilesPerRun: 99999 }).maxFilesPerRun).toBe(200);
    expect(normalizeImportConfig({ maxTextChars: -5 }).maxTextChars).toBe(1000);
    expect(normalizeImportConfig({ maxFileBytes: 'x' }).maxFileBytes).toBe(DEFAULT_IMPORT_CONFIG.maxFileBytes);
  });

  it('"지금 검사" 트리거 파일을 만든다(자식 IPC 프로토콜 없이 스캔을 깨운다)', () => {
    const state = path.join(dir, 'state');
    touchImportTrigger(state);
    expect(fs.existsSync(importTriggerPath(state))).toBe(true);
    const first = fs.statSync(importTriggerPath(state)).mtimeMs;
    touchImportTrigger(state);
    expect(fs.statSync(importTriggerPath(state)).mtimeMs).toBeGreaterThanOrEqual(first);
  });

  it('상태 파일 경로가 설정창과 백엔드에서 같다', () => {
    expect(importLedgerPath('/s')).toBe(path.join('/s', 'folder-import.json'));
  });
});
