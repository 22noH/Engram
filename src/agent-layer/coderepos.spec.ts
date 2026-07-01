import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { loadCodeRepos, resolveRepo } from './coderepos';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cr-')); }

it('파일 없으면 빈 설정', () => {
  expect(loadCodeRepos(tmp())).toEqual({ aliases: {}, searchRoots: [] });
});

it('coderepos.json을 읽는다', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'coderepos.json'), JSON.stringify({ aliases: { api: 'C:/repos/api' }, searchRoots: ['C:/repos'] }));
  expect(loadCodeRepos(dir)).toEqual({ aliases: { api: 'C:/repos/api' }, searchRoots: ['C:/repos'] });
});

it('깨진 json이면 빈 설정', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'coderepos.json'), '{not json');
  expect(loadCodeRepos(dir)).toEqual({ aliases: {}, searchRoots: [] });
});

it('resolveRepo: 존재하는 경로형 입력 → 그 경로', () => {
  const dir = tmp(); // dir 자체가 존재하는 디렉터리
  expect(resolveRepo(dir, { aliases: {}, searchRoots: [] })).toEqual([dir]);
});

it('resolveRepo: alias 적중(대소문자 무시)', () => {
  const cfg = { aliases: { api: 'C:/repos/api' }, searchRoots: [] };
  expect(resolveRepo('API', cfg)).toEqual(['C:/repos/api']);
});

it('resolveRepo: searchRoots 얕은 검색 — 정확 일치 1개', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'myapp'));
  fs.mkdirSync(path.join(root, 'other'));
  expect(resolveRepo('myapp', { aliases: {}, searchRoots: [root] })).toEqual([path.join(root, 'myapp')]);
});

it('resolveRepo: 부분 포함 다중 매칭 → 여러 개', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'app-web'));
  fs.mkdirSync(path.join(root, 'app-api'));
  const r = resolveRepo('app', { aliases: {}, searchRoots: [root] });
  expect(r.sort()).toEqual([path.join(root, 'app-api'), path.join(root, 'app-web')].sort());
});

it('resolveRepo: 매칭 없음 → 빈 배열', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'zzz'));
  expect(resolveRepo('nope', { aliases: {}, searchRoots: [root] })).toEqual([]);
});
