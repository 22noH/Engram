import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { loadChannelPolicy, allows } from './channel-policy';

function tmpConfig(json?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cp-'));
  if (json !== undefined) fs.writeFileSync(path.join(dir, 'channels.json'), json);
  return dir;
}

it('기본값: 명령·ambient는 허용, observe만 거부', () => {
  const p = loadChannelPolicy(tmpConfig()); // 파일 없음
  expect(allows(p, 'any', 'coding')).toBe(true);
  expect(allows(p, 'any', 'schedule')).toBe(true);
  expect(allows(p, 'any', 'collaborate')).toBe(true);
  expect(allows(p, 'any', 'ambient')).toBe(true);
  expect(allows(p, 'any', 'observe')).toBe(false);
});

it('부분 설정 병합: 명시한 키만 덮고 나머지는 기본값', () => {
  const p = loadChannelPolicy(tmpConfig('{"c1":{"coding":false,"observe":true}}'));
  expect(allows(p, 'c1', 'coding')).toBe(false);
  expect(allows(p, 'c1', 'observe')).toBe(true);
  expect(allows(p, 'c1', 'schedule')).toBe(true);   // 미설정 키 → 기본
  expect(allows(p, 'c2', 'coding')).toBe(true);      // 미설정 채널 → 기본
});

it('깨진 JSON → 전부 기본값', () => {
  const p = loadChannelPolicy(tmpConfig('{not json'));
  expect(allows(p, 'c1', 'coding')).toBe(true);
  expect(allows(p, 'c1', 'observe')).toBe(false);
});

it('비boolean 값·알 수 없는 키는 무시(기본값)', () => {
  const p = loadChannelPolicy(tmpConfig('{"c1":{"coding":"no","weird":true,"observe":true}}'));
  expect(allows(p, 'c1', 'coding')).toBe(true);   // "no"는 boolean 아님 → 무시
  expect(allows(p, 'c1', 'observe')).toBe(true);
});

it('배열/원시 루트 → 전부 기본값', () => {
  expect(allows(loadChannelPolicy(tmpConfig('[1,2]')), 'c1', 'observe')).toBe(false);
  expect(allows(loadChannelPolicy(tmpConfig('"str"')), 'c1', 'coding')).toBe(true);
});
