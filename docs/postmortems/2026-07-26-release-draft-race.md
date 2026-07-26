# 릴리스 드래프트 경합 — 3-OS 매트릭스가 릴리스를 3개 만들었다 (v0.0.16)

> 위키(`engram-make-latest-ux`)에 이어붙일 내용. 세션 권한 문제로 위키 저장이 막혀 저장소에 먼저 남긴다.

## 증상

`v0.0.16` 태그를 밀었더니 같은 태그의 **드래프트가 3개** 생겼다(과거엔 2개였다). 자산 8개가 흩어졌다.

| 드래프트 | 자산 |
|---|---|
| A | exe · exe.blockmap · dmg · latest.yml · latest-mac.yml (5) |
| B | AppImage · latest-linux.yml (2) |
| C | dmg.blockmap (1) |

아무거나 하나만 게시하면 그 OS 사용자만 받는다. 사람이 600MB를 내려받아 한 드래프트로 합친 뒤 게시해야 했다.

## 원인 (소스로 확정)

`node_modules/electron-publish/out/gitHubPublisher.js`의 `getOrCreateRelease`:

```js
const releases = await this.githubRequest(`/repos/${owner}/${repo}/releases`, token);
for (const release of releases) {
  if (!(release.tag_name === this.tag || release.tag_name === this.version)) continue;
  if (release.draft) return release;   // ← 드래프트가 있으면 재사용(새로 안 만듦)
  ...
}
// 일치하는 게 하나도 없을 때만
if (this.options.publish === "always" || getCiTag() != null) return this.createRelease();
```

3-OS 매트릭스 잡이 **동시에** `electron-builder --publish always`를 돌리면 셋 다 목록을 훑는 시점에 릴리스가 없으므로 각자 `createRelease()`를 부른다. 전형적인 check-then-act 경합이고, OS 잡 수만큼 드래프트가 생긴다.

## 수정 — 드래프트 선점 (병렬은 유지)

`.github/workflows/desktop-release.yml`을 3단계로 나눴다 (커밋 `6ce5e29`).

```
draft   → 빌드 전에 이 태그의 드래프트를 하나만 만든다 (gh release create --draft)
build   → 3-OS 매트릭스가 그 드래프트를 찾아 자산만 올린다 (needs: draft, 병렬 유지)
publish → 세 매니페스트 확인 후 make_latest로 게시 (needs: build)
```

위 소스대로 드래프트가 **먼저** 존재하면 세 잡 모두 재사용하므로 경합이 사라진다. 매트릭스를 `max-parallel: 1`로 직렬화하는 해법도 있지만 빌드 시간이 3배(9분→27분)라 선점이 낫다.

곁들여 닫은 구멍 둘:

- **반쪽 릴리스 차단** — `publish`가 `needs: build`라 한 OS라도 실패하면 게시 자체가 안 돈다. 드래프트로 남았다가 실패한 OS만 재실행하면 이어서 나간다.
- **make_latest 자동화** — 게시를 `gh api -X PATCH ... -F draft=false -F make_latest=true`로 워크플로가 직접 한다. v0.0.11의 "latest 미지정 → 자동 업데이트 무반응" 경로가 닫혔다.

검증은 자산 **개수(8)가 아니라** `latest.yml`·`latest-mac.yml`·`latest-linux.yml` 세 매니페스트의 존재로 판정한다. 개수는 빌드 타깃이 바뀌면 깨지는 숫자고, 매니페스트 셋은 "OS별 잡이 실제로 올렸는가"를 뜻한다.

## 손으로 병합해야 할 때의 함정

- **목표 드래프트는 가장 큰 자산이 있는 쪽으로 잡아라** — 전송량이 그만큼 준다(766MB AppImage 쪽을 목표로 해서 591MB만 옮겼다).
- **PowerShell 리디렉션(`>`)으로 바이너리를 받지 마라** — 텍스트로 변환돼 망가진다. `curl.exe -o`를 쓴다.
- **Windows PowerShell 5.1은 .ps1을 ANSI로 읽는다** — 한글 주석이 든 스크립트가 파싱 단계에서 죽는다. 스크립트 파일은 ASCII로 쓴다.
- **`echo "$X" | grep -q`는 `set -o pipefail`과 만나면 위험하다** — grep이 먼저 닫아 SIGPIPE(141)가 나면 일치하는데도 실패로 잡힌다. here-string(`grep -Fxq "$f" <<< "$X"`)을 쓴다.
- 병합 후엔 `latest.yml`의 sha512·size가 실제 인스톨러와 맞는지 확인하고 게시한다(전송 무결성).

## 남은 것

`desktop-release.yml`·`npm-publish.yml`이 빌드 체인을 각자 복사해 두고 드리프트한다(v0.0.15 npm 게시가 콘솔 의존성 누락으로 실패한 원인). 공용 composite action이나 root workspaces로 통합 필요.
