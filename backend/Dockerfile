# syntax=docker/dockerfile:1
#
# Backend image for Railway. The build context is the repository root (the Railway Root
# Directory stays `/`), so paths below are relative to it:
#
#   docker build -f backend/Dockerfile -t six7-backend .
#
# The image keeps dev dependencies on purpose. `db:migrate`, `db:secure` and `jobs:refresh` run
# through `tsx`, and Railway runs the pre-deploy command and the cron inside this image.
# See DEPLOYMENT.md, "Chrome for the job scraper" and "Running the Backend Image Locally".

# Exact tag so Dependabot can bump it. It must satisfy `engines.node` in the root package.json.
FROM node:26.13.1-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Pin corepack instead of relying on the version the base image bundles. Node 22.12 shipped
# corepack 0.29.4, whose npm signing keys have since been rotated, so it refused to download
# pnpm ("Cannot find matching keyid"). Newer Node lines may not bundle corepack at all, so the
# explicit install keeps the working version from depending on which base image tag is in use.
RUN npm install -g corepack@0.36.0 && corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------------------------
FROM base AS build

# Manifests first, so the install layer is reused until a dependency changes. Every workspace
# manifest is needed for the frozen lockfile check, but only the backend's dependencies are
# installed: `@six7swe/backend...` selects the backend and the workspace packages it depends on
# (`@six7swe/knowledge-types`). NODE_ENV is unset here, so devDependencies are installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY knowledge/package.json knowledge/
COPY packages/knowledge-types/package.json packages/knowledge-types/
RUN pnpm install --frozen-lockfile --filter "@six7swe/backend..."

# Chrome, in its own layer: it depends only on the installed puppeteer version and
# `.puppeteerrc.cjs`, so a source change does not download it again. `.puppeteerrc.cjs` puts it
# in backend/.cache/puppeteer, inside the app directory, so it is copied to the runtime stage with
# the rest of the app. pnpm does not run puppeteer's postinstall, hence the explicit install. No
# `--install-deps`: the libraries are installed in the runtime stage, which is the image that
# runs. The library list is kept outside /app so it is not copied into the runtime image.
COPY backend/.puppeteerrc.cjs backend/
RUN cd backend \
  && pnpm run browsers:install \
  && cp .cache/puppeteer/chrome/*/chrome-linux64/deb.deps /tmp/chrome-deb.deps

# backend/tsconfig.json extends the root base config; tsx reads it too. `backend/.cache` is in
# .dockerignore, so this copy leaves the Chrome download in place. The backend's build compiles
# the shared `packages/knowledge-types` first; the runtime loads its `dist/`.
COPY tsconfig.base.json ./
COPY packages/knowledge-types/ packages/knowledge-types/
COPY backend/ backend/
RUN cd backend && pnpm build

# ---------------------------------------------------------------------------------------------
FROM base AS runtime

# Chrome's shared libraries, from the `deb.deps` list that ships with the Chrome build puppeteer
# installed, the same list `browsers install --install-deps` reads. `apt-get satisfy` accepts
# its version constraints and alternatives. The list includes ca-certificates and
# fonts-liberation.
COPY --from=build /tmp/chrome-deb.deps /tmp/chrome-deb.deps
RUN apt-get update \
  && apt-get satisfy -y --no-install-recommends "$(tr '\n' ',' < /tmp/chrome-deb.deps | sed 's/,*$//')" \
  && rm -rf /var/lib/apt/lists/* /tmp/chrome-deb.deps

# The app is owned by `node` (the base image's unprivileged user, uid 1000), so the server, the
# pre-deploy command and the cron run without root. `WORKDIR /app` in the base stage created /app
# root-owned and --chown on the COPY only covers the copied contents, so /app itself is chowned
# here, non-recursively (an empty directory at this point). --chown on the COPY avoids a
# recursive chown layer that would duplicate the whole app.
RUN chown node:node /app
COPY --from=build --chown=node:node /app /app

# Production mode for everything that runs in the image: the server, the pre-deploy command and
# the cron. Among other things it arms the guard that refuses to start with AUTH_DEV_BYPASS set.
ENV NODE_ENV=production

# Commands run from the backend package, which has no `packageManager` of its own, so corepack
# resolves the root one (/app/package.json): one pnpm version for build and runtime.
# Run as `node` from here on, then let corepack fetch pnpm now rather than on first use at
# runtime. COREPACK_HOME pins the cache to node's home, so the prefetched pnpm is found at
# runtime whatever HOME is set to and nothing is downloaded when the container starts.
ENV COREPACK_HOME=/home/node/.cache/corepack
USER node
WORKDIR /app/backend
RUN corepack install
# Fail the build if corepack stops resolving the root pin from here (for example, if a
# packageManager field reappears in backend/package.json), rather than run another pnpm.
RUN test "$(pnpm --version)" = "$(node -p "require('/app/package.json').packageManager.split('@')[1].split('+')[0]")"

# Railway's start command overrides this. Exec form, so it needs no shell.
CMD ["pnpm", "start"]
