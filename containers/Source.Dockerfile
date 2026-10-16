# syntax=docker/dockerfile:1
# Private support runtime uses Ubuntu 22.04 ABI baseline for both supported Ubuntu releases.
FROM ubuntu:22.04@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401 AS support
ENV DEBIAN_FRONTEND=noninteractive CI=true
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates build-essential pkg-config python3 libssl-dev libsqlite3-dev libffi-dev zlib1g-dev libbz2-dev liblzma-dev libreadline-dev libncurses-dev xz-utils
COPY scripts/stage-support-runtime.py /tools/stage.py
ARG TARGET_OS
RUN python3 -c "import sys;sys.path.insert(0,'/tools');import stage;from pathlib import Path;stage.stage(Path('/support'),Path('/downloads'),sys.argv[1])" "$TARGET_OS"
RUN dpkg-query -W > /support-build-packages.txt
# Trusted source bootstrap only; never used as a project worker.
FROM node:24.16.0-bookworm@sha256:40ad9f3064e67d6860b4bc3fe1880b2953934fd6320ada990e45fe0efa6badd7 AS build
WORKDIR /src
ENV CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 ABYSSUS_BUILD_ROOT=/payload ABYSSUS_WEB_OUTPUT=/web
COPY package.json package-lock.json ./
RUN npm ci --foreground-scripts
COPY tsconfig.json vite.config.ts index.html ./
COPY client ./client
COPY server ./server
COPY shared ./shared
COPY desktop ./desktop
COPY containers ./containers
COPY helper/core.py helper/apt_adapter.py ./helper/
COPY scripts/desktop-build.mjs scripts/stage-support-runtime.py scripts/stage-container-runtime.py scripts/source-payload.py ./scripts/
RUN npm run desktop:build
# Desktop dependencies are pure JavaScript, installed from the same lock without hooks.
RUN cp package.json package-lock.json /payload/app/ && cd /payload/app && npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
ARG TARGET_OS
ARG SOURCE_COMMIT
ARG CONTROLLER_IMAGE
ARG WORKER_IMAGE
COPY --from=support /support /payload/support-runtime
COPY --from=support /support-build-packages.txt /payload/support-build-packages.txt
RUN python3 scripts/source-payload.py --platform "$TARGET_OS" --source "$SOURCE_COMMIT" --controller "$CONTROLLER_IMAGE" --worker "$WORKER_IMAGE"
FROM scratch AS payload
COPY --from=build /payload/ /
