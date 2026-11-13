# syntax=docker/dockerfile:1
#
# Backend image for Railway. The build context is the repository root (the Railway Root
# Directory stays `/`), so paths below are relative to it:
#
#   docker build -f backend/Dockerfile -t six7-backend .
#
# The image keeps dev dependencies on purpose. `db:migrate`, `db:secure` and `jobs:refresh` run
# through `tsx`, and Railway runs the pre-deploy command and the cron inside this image.
# See DEPLOYMENT.md, "Chrome for the job scraper" and "Running the backend image locally".

# Exact tag so Dependabot can bump it. It must satisfy `engines.node` in the root package.json.
FROM node:22.12.0-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# The corepack bundled with Node 22.12 carries npm signing keys that have since been rotated, so
# it refuses to download pnpm ("Cannot find matching keyid"). Replace it with a current release.
RUN npm install -g corepack@0.36.0 && corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------------------------
FROM base AS build

# Manifests first, so the install layer is reused until a dependency changes. Every workspace
# manifest is needed for the frozen lockfile check, but only the backend's dependencies are
# installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN pnpm install --frozen-lockfile --filter @six7swe/backend

# backend/tsconfig.json extends the root base config; tsx reads it too.
COPY tsconfig.base.json ./
COPY backend/ backend/

# `.puppeteerrc.cjs` puts Chrome in backend/.cache/puppeteer, inside the app directory, so it
# is copied to the runtime stage with the rest of the app. pnpm does not run puppeteer's
# postinstall, hence the explicit install. No `--install-deps`: the libraries are installed in
# the runtime stage, which is the image that runs.
RUN cd backend \
  && pnpm build \
  && pnpm run browsers:install \
  && cp .cache/puppeteer/chrome/*/chrome-linux64/deb.deps /app/chrome-deb.deps

# ---------------------------------------------------------------------------------------------
FROM base AS runtime

# Chrome's shared libraries, from the `deb.deps` list that ships with the Chrome build puppeteer
# installed, the same list `browsers install --install-deps` reads. `apt-get satisfy` accepts
# its version constraints and alternatives. The list includes ca-certificates and
# fonts-liberation.
COPY --from=build /app/chrome-deb.deps /tmp/chrome-deb.deps
RUN apt-get update \
  && apt-get satisfy -y --no-install-recommends "$(tr '\n' ',' < /tmp/chrome-deb.deps | sed 's/,*$//')" \
  && rm -rf /var/lib/apt/lists/* /tmp/chrome-deb.deps

COPY --from=build /app /app

# Corepack fetches pnpm on first use. The root and backend/package.json pin different pnpm
# versions, so fetch both now; otherwise the first `pnpm` in each directory downloads it at
# runtime.
RUN corepack install && cd backend && corepack install

# Railway's start command overrides this. Exec form with no `cd`, so it needs no shell.
CMD ["pnpm", "--dir", "backend", "start"]
