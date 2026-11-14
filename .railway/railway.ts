/**
 * Railway infrastructure for six7swe, production environment.
 *
 * Railway does not read this file during deploys. A change here reaches Railway only through
 * `railway config plan` followed by `railway config apply`, run by hand (see DEPLOYMENT.md,
 * "Changing Railway config"). An apply is declarative: a service, variable or custom domain
 * missing from this file is deleted, so check the plan for destructive entries before applying.
 *
 * Every service builds from the repository root (Root Directory `/`). The frontend and the
 * knowledge service build with Railpack, and their commands `cd` into the package. The backend
 * builds from `backend/Dockerfile`, whose build context is that same root.
 * Secrets are never written here: `preserve()` keeps the value already set in Railway.
 */
import { defineRailway, github, preserve, project, service } from 'railway/iac';

const repo = github('raymanguino/six7swe', { branch: 'main', checkSuites: false });

const restartPolicy = {
  restartPolicyType: 'ON_FAILURE',
  restartPolicyMaxRetries: 10,
} as const;

export default defineRailway(() => {
  const frontend = service('@six7swe/frontend', {
    source: repo,
    // Railpack runs `pnpm install` at the workspace root before the build command.
    build: {
      builder: 'RAILPACK',
      buildCommand: 'cd frontend && pnpm build',
      // The frontend plus the root files the build reads: Railpack installs from the workspace
      // root, and frontend/tsconfig.json extends tsconfig.base.json.
      watchPatterns: [
        '/frontend/**',
        '/package.json',
        '/pnpm-lock.yaml',
        '/pnpm-workspace.yaml',
        '/tsconfig.base.json',
      ],
    },
    start: 'cd frontend && pnpm preview --host',
    deploy: { ...restartPolicy },
    replicas: { 'us-east4-eqdc4a': 1 },
    // `vite preview` listens on 4173; `six7swe.up.railway.app` is Railway-generated and kept.
    domains: [{ domain: 'ray-manguino.dev', port: 4173 }],
    env: {
      VITE_API_URL: preserve(),
      VITE_SUPABASE_URL: preserve(),
      VITE_SUPABASE_ANON_KEY: preserve(),
    },
  });

  const backend = service('@six7swe/backend', {
    source: repo,
    // The Dockerfile's runtime stage installs Chrome's shared libraries, so the image that is
    // built is the image that runs (DEPLOYMENT.md, "Chrome for the job scraper"). Railway runs a
    // Dockerfile service's start command in exec form, without a shell, so neither command uses
    // `cd` or `&&`; the image's working directory is already /app/backend. `db:deploy` is a
    // package script, and pnpm runs scripts in a shell.
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'backend/Dockerfile',
      // The backend, the shared package it builds, and the root files the Dockerfile copies.
      watchPatterns: [
        '/backend/**',
        '/packages/knowledge-types/**',
        '/.dockerignore',
        '/package.json',
        '/pnpm-lock.yaml',
        '/pnpm-workspace.yaml',
        '/tsconfig.base.json',
      ],
    },
    start: 'pnpm start',
    // `db:deploy` migrates, then secures: a table a migration creates starts with the default
    // Supabase grants, so `db:secure` must run after it (docs/SECURITY.md).
    preDeploy: 'pnpm db:deploy',
    deploy: { ...restartPolicy },
    replicas: { 'us-west2': 1 },
    networking: { privateNetworkEndpoint: 'six7swebackend' },
    env: {
      NODE_ENV: preserve(),
      PORT: preserve(),
      DATABASE_URL: preserve(),
      MINIMAX_API_KEY: preserve(),
      MINIMAX_API_KEY_SECONDARY: preserve(),
      RESEND_API_KEY: preserve(),
      RESEND_FROM_EMAIL: preserve(),
      RESEND_FROM_NAME: preserve(),
      SUPABASE_URL: preserve(),
      PORTFOLIO_CACHE_TTL_MS: preserve(),
      // #120 took this out of the file, so an apply would delete the value set by hand in
      // Railway. preserve() keeps it, and lets the owner switch chat to `knowledge` in Railway
      // without this file doing it.
      PORTFOLIO_DATA_SOURCE: preserve(),
      // The knowledge service's private address, one variable for both clients: chat retrieval
      // (PORTFOLIO_DATA_SOURCE=knowledge) and the owner proxy below. The retrieval key is the
      // knowledge service's KNOWLEDGE_SERVICE_KEY, set to the same value on both services.
      KNOWLEDGE_URL: 'http://six7sweknowledge.railway.internal:3100',
      KNOWLEDGE_SERVICE_KEY: preserve(),
      // Chunks retrieved per chat question. Chosen from the #84 chat eval (10 seed questions:
      // stuffed mean 8.50 vs retrieved 9.20 at k=10; the default of 6 did not match stuffed).
      // The service caps it at MAX_RETRIEVE_K (20).
      KNOWLEDGE_RETRIEVE_K: '10',
      // The knowledge owner proxy (/knowledge/*): the backend checks the owner's JWT, then
      // calls the knowledge service over the private network with its owner key.
      OWNER_AUTH_ID: preserve(),
      KNOWLEDGE_OWNER_KEY: preserve(),
    },
  });

  const knowledge = service('@six7swe/knowledge', {
    source: repo,
    // A plain Node service, so Railpack is enough. It runs `pnpm install` at the workspace root
    // before the build command.
    build: {
      builder: 'RAILPACK',
      buildCommand: 'cd knowledge && pnpm build',
      // The service, the shared contract package its build compiles first, and the root files
      // its build reads: Railpack installs from the workspace root, and knowledge/tsconfig.json
      // extends tsconfig.base.json.
      watchPatterns: [
        '/knowledge/**',
        '/packages/knowledge-types/**',
        '/package.json',
        '/pnpm-lock.yaml',
        '/pnpm-workspace.yaml',
        '/tsconfig.base.json',
      ],
    },
    // Railpack runs the start command in a shell, so `cd … &&` works.
    start: 'cd knowledge && pnpm start',
    // Applies the migrations with the migrator `pnpm build` compiled to dist/db/migrate.js, so
    // it needs only runtime dependencies. Railway documents shell execution for Railpack start
    // commands but not for pre-deploy commands, so this one avoids `cd … &&`: `--filter` runs
    // the package script from knowledge/, and pnpm runs scripts in a shell.
    preDeploy: 'pnpm --filter @six7swe/knowledge db:migrate:prod',
    healthcheck: '/health',
    deploy: { ...restartPolicy },
    // Same region as the backend, its main caller over the private network.
    replicas: { 'us-west2': 1 },
    // Private networking only (six7sweknowledge.railway.internal); the backends call it there.
    // The owner's Knowledge page goes through the backend's /knowledge/* proxy, so the browser
    // never needs a public domain. Step 7 (#89) adds one if Claude-client access needs it.
    networking: { privateNetworkEndpoint: 'six7sweknowledge' },
    // Only the variables the service requires. Optional ones (EMBEDDER, EMBEDDING_MODEL,
    // FILE_STORE, STORAGE_BUCKET, MAX_UPLOAD_BYTES, RESUME_INGESTION_ON_BOOT, ...) are left
    // out: their defaults are right for production, and an apply deletes any variable missing
    // here, so listing one would only invite setting it.
    env: {
      NODE_ENV: 'production',
      // Pinned (the service's own default), like the backend's PORT: private-network callers
      // need a known port, http://six7sweknowledge.railway.internal:3100.
      PORT: '3100',
      // Railway's private network is IPv6-only in environments created before 16 October
      // 2025, so listen on `::`, which accepts IPv6 and IPv4. It is also the code's default;
      // it is pinned here so a change to that default cannot break the private network.
      HOST: '::',
      DATABASE_URL: preserve(),
      KNOWLEDGE_SERVICE_KEY: preserve(),
      KNOWLEDGE_OWNER_KEY: preserve(),
      OWNER_AUTH_ID: preserve(),
      OPENAI_API_KEY: preserve(),
      SUPABASE_URL: preserve(),
      SUPABASE_SECRET_KEY: preserve(),
    },
  });

  const definition = {
    // This file owns every variable on these services. The CLI (5.74) reads this option but the
    // SDK's types (railway 3.17) do not declare it yet, so it is passed as a variable rather than
    // an object literal, which skips the excess-property check.
    variables: { managed: true },
    resources: [frontend, backend, knowledge],
  };
  return project('six7swe', definition);
});
