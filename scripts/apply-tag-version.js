// 태그가 버전의 단일 출처(사용자 결정 2026-07-25): `git tag v0.0.15` 하나로 앱·npm·플러그인
// 버전이 전부 그 숫자가 된다. CI가 빌드 직전 이 스크립트로 파일에 값을 써 넣는다.
//
// 사람이 미리 `npm version`을 돌릴 필요가 없다 — 태그만 밀면 된다.
// 로컬에서 굳이 맞추고 싶으면 `npm version <x>`도 그대로 동작한다(scripts/sync-versions.js가 짝).
const fs = require('fs');
const path = require('path');

const raw = process.argv[2] || '';
const version = raw.replace(/^refs\/tags\//, '').replace(/^v/, '');

// vX.Y.Z(+프리릴리스)만 허용 — 오타 태그로 이상한 버전이 배포되는 걸 막는다.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`태그에서 버전을 읽을 수 없습니다: "${raw}" (예상 형식: v0.0.15)`);
  process.exit(1);
}

const root = path.join(__dirname, '..');
// "version" 줄만 치환한다 — JSON 재직렬화는 키 순서·들여쓰기를 흔들어 diff를 더럽힌다.
const targets = [
  path.join(root, 'package.json'),
  path.join(root, 'plugin', '.claude-plugin', 'plugin.json'),
];

const VERSION_FIELD = /("version"\s*:\s*")[^"]*(")/;

for (const file of targets) {
  const text = fs.readFileSync(file, 'utf8');
  if (!VERSION_FIELD.test(text)) {
    console.error(`${file} 에 version 필드를 찾지 못했습니다`);
    process.exit(1);
  }
  fs.writeFileSync(file, text.replace(VERSION_FIELD, `$1${version}$2`));
  console.log(`${path.relative(root, file)} -> ${version}`);
}
