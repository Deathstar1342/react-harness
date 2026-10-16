# Official multi-platform index resolved from registry-1.docker.io, 2026-10-16.
FROM node:24.16.0-bookworm@sha256:40ad9f3064e67d6860b4bc3fe1880b2953934fd6320ada990e45fe0efa6badd7 AS build
# The full official image pins the compiler/Python/CA toolchain with its digest.
# No apt resolution or TLS bootstrap is needed during our build.
RUN python3 --version && make --version && g++ --version && test -s /etc/ssl/certs/ca-certificates.crt
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --foreground-scripts && node -e 'require("node:sqlite"); require("node-pty")'
COPY tsconfig.json vite.config.ts index.html ./
COPY server ./server
COPY shared ./shared
COPY client ./client
RUN npm run build

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY containers ./containers
USER 1000:1000
ENV NODE_ENV=production HOME=/tmp
EXPOSE 3000
CMD ["node", "--import", "tsx", "containers/controller.ts"]
