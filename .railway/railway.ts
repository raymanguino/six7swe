/**
 * Railway infrastructure for six7swe, production environment.
 *
 * Railway does not read this file during deploys. A change here reaches Railway only through
 * `railway config plan` followed by `railway config apply`, run by hand (see DEPLOYMENT.md,
 * "Changing Railway config"). An apply is declarative: a service, variable or custom domain
 * missing from this file is deleted, so check the plan for destructive entries before applying.
 *
 * Both services build from the repository root, so their commands `cd` into the package.
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
    build: {
      builder: 'NIXPACKS',
      buildCommand: 'cd frontend && pnpm install && pnpm build',
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
    // Nixpacks builds and runs in one image, so the Chrome libraries that
    // `browsers:install --install-deps` installs with apt-get at build time are still there at
    // runtime. Railpack (the dashboard default) uses a separate runtime image; moving to it needs
    // those libraries listed as deploy apt packages first.
    build: {
      builder: 'NIXPACKS',
      buildCommand:
        'apt-get update && cd backend && pnpm install && pnpm run browsers:install --install-deps && pnpm build',
      watchPatterns: ['/backend/**'],
    },
    start: 'cd backend && pnpm start',
    // Migrate first: a table a migration creates starts with the default Supabase grants, so
    // `db:secure` must run after it (docs/SECURITY.md).
    preDeploy: 'cd backend && pnpm db:migrate -- --remote && pnpm db:secure -- --remote',
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
