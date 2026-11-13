/**
 * Railway infrastructure for six7swe, production environment.
 *
 * Railway does not read this file during deploys. A change here reaches Railway only through
 * `railway config plan` followed by `railway config apply`, run by hand (see DEPLOYMENT.md,
 * "Changing Railway config"). An apply is declarative: a service, variable or custom domain
 * missing from this file is deleted, so check the plan for destructive entries before applying.
 *
 * Both services build from the repository root (Root Directory `/`). The frontend builds with
 * Railpack, and its commands `cd` into the package. The backend builds from `backend/Dockerfile`,
 * whose build context is that same root.
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
      watchPatterns: ['/frontend/**'],
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
    // `cd` or `&&`. `db:deploy` is a package script, and pnpm runs scripts in a shell.
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'backend/Dockerfile',
      watchPatterns: ['/backend/**', '/.dockerignore'],
    },
    start: 'pnpm --dir backend start',
    // `db:deploy` migrates, then secures: a table a migration creates starts with the default
    // Supabase grants, so `db:secure` must run after it (docs/SECURITY.md).
    preDeploy: 'pnpm --dir backend db:deploy',
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
      PORTFOLIO_DATA_SOURCE: preserve(),
    },
  });

  const definition = {
    // This file owns every variable on these services. The CLI (5.74) reads this option but the
    // SDK's types (railway 3.17) do not declare it yet, so it is passed as a variable rather than
    // an object literal, which skips the excess-property check.
    variables: { managed: true },
    resources: [frontend, backend],
  };
  return project('six7swe', definition);
});
