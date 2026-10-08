# bravebot: multi-stage, multi-arch (linux/amd64 + linux/arm64) image.
# @snazzah/davey ships prebuilt linux-{x64,arm64}-gnu binaries (glibc base image required).
# @discordjs/opus (native libopus) has no prebuild for trixie's glibc, so prod-deps compiles it
# from its bundled libopus source; the toolchain never reaches the runtime image.

# No `# syntax=` directive: the frontend built into the pinned BuildKit is used, so no
# floating frontend image is pulled.

# Base image is written literally on each FROM (not via ARG) so Renovate can update it.
# It is pinned to a full Node version AND the multi-arch index digest: Renovate then opens
# fix(deps) PRs for Node 22 minor/patch releases and for Debian security rebuilds of the same
# tag (its allowedVersions rule keeps us on Node 22 LTS). Keep all three FROM lines identical.

# ---------------------------------------------------------------------------
# build: compile TypeScript. Output is platform-independent JS, so run it on the
# build host's native platform (avoids slow QEMU emulation for the dev install).
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:22.23.3-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Only compiles TypeScript, so skip install scripts (no native @discordjs/opus build here).
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# prod-deps: production dependencies for the TARGET platform (platform-specific
# optional packages such as @snazzah/davey-linux-arm64-gnu are selected here).
# ---------------------------------------------------------------------------
FROM node:22.23.3-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS prod-deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# --build-from-source: never download a prebuilt binary.
# CFLAGS: @discordjs/opus's arm64 config disables NEON (no OPUS_ARM_MAY_HAVE_NEON_INTR/RTCD) yet
# still compiles celt_neon_intr.c, whose unreachable float path calls an undeclared function.
# GCC 14 makes that an error; downgrading it to a warning matches how older compilers built it.
# npm_config_nodedir: compile against the headers shipped in this (digest-pinned) image instead
# of downloading them from nodejs.org.
RUN npm_config_nodedir=/usr/local CFLAGS="-Wno-error=implicit-function-declaration" \
    npm ci --omit=dev --no-audit --no-fund --build-from-source \
 && npm cache clean --force

# ---------------------------------------------------------------------------
# runtime: node + ffmpeg + yt-dlp, non-root, with tini as PID 1 (reaps orphaned
# yt-dlp/ffmpeg grandchildren after SIGKILL; forwards SIGTERM to node).
# ---------------------------------------------------------------------------
FROM node:22.23.3-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp lives in its own venv (Debian's system Python is externally managed, PEP 668).
# docker/requirements.txt is a hash-pinned lockfile (pip-compile) covering every transitive
# dependency; --require-hashes --no-deps installs exactly it, from wheels only.
COPY docker/requirements.txt /opt/yt-dlp/requirements.txt
RUN python3 -m venv /opt/yt-dlp/venv \
 && /opt/yt-dlp/venv/bin/pip install --no-cache-dir --require-hashes --no-deps --only-binary=:all: \
      -r /opt/yt-dlp/requirements.txt \
 && ln -s /opt/yt-dlp/venv/bin/yt-dlp /usr/local/bin/yt-dlp \
 && yt-dlp --version \
 && ffmpeg -hide_banner -version | head -n 1
COPY docker/yt-dlp.conf /etc/yt-dlp.conf

ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# The official node image provides an unprivileged "node" user (uid 1000).
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
