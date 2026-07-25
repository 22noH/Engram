// 버전 단일화(사용자 결정 2026-07-25): package.json 하나가 앱·npm 패키지·플러그인 버전의 단일 출처다.
// `npm version <x>`가 이 스크립트를 자동 실행해(package.json의 version 라이프사이클) 플러그인 버전을 맞춘다.
// --check 로 실행하면 고치지 않고 어긋남만 검사한다(CI 게이트).
//
// 플러그인은 버전을 올려야만 사용자 쪽에서 갱신된다(실사고: 0.0.2에 멈춰 있던 건). 매 릴리스마다
// 같이 올라가므로 그 함정도 같이 사라진다.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const pluginPath = path.join(root, 'plugin', '.claude-plugin', 'plugin.json');

const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
const check = process.argv.includes('--check');

const raw = fs.readFileSync(pluginPath, 'utf8');
const plugin = JSON.parse(raw);

if (plugin.version === version) {
  if (check) console.log(`versions in sync: ${version}`);
  process.exit(0);
}

if (check) {
  console.error(`version mismatch: package.json=${version} plugin.json=${plugin.version}`);
  console.error('run `node scripts/sync-versions.js` (or `npm version <x>`) to fix');
  process.exit(1);
}

// 들여쓰기·키 순서를 보존하기 위해 JSON 재직렬화 대신 해당 줄만 치환한다(불필요한 diff 방지).
const next = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
if (next === raw) {
  console.error('plugin.json에 version 필드를 찾지 못했습니다');
  process.exit(1);
}
fs.writeFileSync(pluginPath, next);
console.log(`plugin.json ${plugin.version} -> ${version}`);
