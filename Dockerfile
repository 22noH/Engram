# Engram 서버 에디션(headless) 컨테이너 이미지.
# 데몬 엔트리포인트는 dist/src/main.js (NestJS 빌드) — bind/port/role은 ENGRAM_DATA_DIR 안의
# chat.json에서 읽고, ENGRAM_CHAT_BIND/ENGRAM_CHAT_PORT 환경변수가 있으면 그 값이 우선한다.
# ENGRAM_DESKTOP은 절대 설정하지 않는다 — 설정 시 /admin 웹 콘솔이 비활성화된다(데스크톱 앱 전용 가드).
#
# 멀티스테이지: builder에서 컴파일 산출물(dist/·console/dist)을 만들고,
# runner에는 그 산출물과 "npm ci --omit=dev"로 새로 설치한 프로덕션 전용 node_modules만 담는다
# (builder의 node_modules는 electron 등 devDependencies를 포함해 그대로 옮기면 이미지가 비대해진다).

# ---- Stage 1: builder — nest build + 웹 콘솔(console/dist) 빌드 ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# LanceDB(@lancedb/lancedb)·onnxruntime-node(@huggingface/transformers 경유)는
# 플랫폼별 프리빌드 네이티브 바이너리를 postinstall로 그대로 사용하는 게 정상 경로다.
# 혹시 이 Node 버전/아키텍처에 맞는 프리빌드가 없어 소스 빌드로 폴백하는 예외 상황을 대비한 안전망.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY nest-cli.json tsconfig.json ./
COPY src ./src
RUN npm run build

# admin-http.ts가 resolveResourceDir('console/dist')로 정적 서빙하는 /admin 웹 콘솔.
# console/dist는 저장소에 커밋되지 않는 빌드 산출물이라 이미지 안에서 직접 빌드해야 한다.
COPY console/package.json console/package-lock.json ./console/
RUN npm --prefix console ci
COPY console ./console
RUN npm --prefix console run build

# ---- Stage 2: runner — 프로덕션 전용 최소 이미지 ----
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV ENGRAM_DATA_DIR=/data
# transformers.js 임베딩 모델 캐시 위치. 미지정 시 컨테이너 안 기본 경로에 남아 재시작/재생성마다
# 재다운로드된다 — 데이터 볼륨(/data) 밑에 두어 볼륨과 함께 영속되게 한다.
ENV ENGRAM_MODEL_CACHE_DIR=/data/models

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/console/dist ./console/dist
COPY prompts ./prompts
COPY personas ./personas

# 이미지에 기본 포함된 node 사용자(uid 1000)로 non-root 실행.
RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 47800
CMD ["node", "dist/src/main.js"]
