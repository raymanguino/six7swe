import { buildWorkerAccessStatements, resolveWorkerRole, WORKER_POLICY } from '../../db/workerRole';
import { OWNER_ROLE } from '../../db/security';

const password = 'a'.repeat(64);
const url = (user: string, pass = password): string =>
  `postgresql://${user}:${pass}@db.example.test:5432/postgres`;

describe('resolveWorkerRole', () => {
  it('is null when no worker URL is set', () => {
    expect(resolveWorkerRole(undefined, OWNER_ROLE, 'six7swe_app')).toBeNull();
  });

  it('reads the role from the pooler user', () => {
    expect(resolveWorkerRole(url('six7swe_worker.abcdef'), OWNER_ROLE, 'six7swe_app')).toEqual({
      role: 'six7swe_worker',
      password,
    });
  });

  it.each([
    ['the owner', url('postgres.abcdef'), /table owner/],
    ['the runtime role', url('six7swe_app.abcdef'), /other than DATABASE_URL/],
    ['a reserved role', url('authenticated'), /reserved role/],
    ['a short password', url('six7swe_worker', 'short'), /at least 32/],
  ])('refuses %s', (_, workerUrl, message) => {
    expect(() => resolveWorkerRole(workerUrl, OWNER_ROLE, 'six7swe_app')).toThrow(message);
  });
});

describe('buildWorkerAccessStatements', () => {
  const tables = ['jobs', 'profile_jobs', 'profiles', 'refresh_status', 'users', 'later_table'];
  const sequences = ['jobs_id_seq', 'profile_jobs_id_seq', 'refresh_status_id_seq', 'users_id_seq'];
  const statements = buildWorkerAccessStatements({ tables, sequences }, 'six7swe_worker', []);
  const joined = statements.join('\n');

  it('clears every privilege, including default privileges, before granting', () => {
    const revoke = statements.indexOf(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM "six7swe_worker";',
    );
    const firstTableGrant = statements.findIndex((s) => s.startsWith('GRANT SELECT'));
    expect(revoke).toBeGreaterThan(-1);
    expect(firstTableGrant).toBeGreaterThan(revoke);
    expect(joined).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM "six7swe_worker";',
    );
    expect(joined).not.toMatch(/ALTER DEFAULT PRIVILEGES .* GRANT/);
  });

  it('grants only the refresh tables, and only the user columns it reads', () => {
    expect(joined).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public."jobs" TO "six7swe_worker";',
    );
    expect(joined).toContain('GRANT SELECT ON TABLE public."profiles" TO "six7swe_worker";');
    expect(joined).toContain(
      'GRANT SELECT (id, auth_id) ON TABLE public."users" TO "six7swe_worker";',
    );
    expect(joined).not.toMatch(/DELETE|TRUNCATE/);
    expect(joined).not.toMatch(/GRANT .* "later_table"/);
  });

  it('admits the worker by policy on its tables and removes the policy elsewhere', () => {
    expect(joined).toContain(
      `CREATE POLICY ${WORKER_POLICY} ON public."users" FOR SELECT TO "six7swe_worker" USING (true);`,
    );
    expect(joined).toContain(
      `CREATE POLICY ${WORKER_POLICY} ON public."refresh_status" FOR ALL TO "six7swe_worker" ` +
        'USING (true) WITH CHECK (true);',
    );
    expect(joined).toContain(`DROP POLICY IF EXISTS ${WORKER_POLICY} ON public."later_table";`);
    expect(joined).not.toContain(`CREATE POLICY ${WORKER_POLICY} ON public."later_table"`);
  });

  it('grants the sequences of the tables it inserts into', () => {
    expect(joined).toContain(
      'GRANT USAGE, SELECT ON SEQUENCE public."jobs_id_seq", public."profile_jobs_id_seq", ' +
        'public."refresh_status_id_seq" TO "six7swe_worker";',
    );
    expect(joined).not.toContain('"users_id_seq" TO');
  });

  it('fails when a table it needs is missing', () => {
    expect(() =>
      buildWorkerAccessStatements({ tables: ['jobs'], sequences: [] }, 'six7swe_worker', []),
    ).toThrow(/missing from public: profile_jobs/);
    expect(() =>
      buildWorkerAccessStatements({ tables, sequences: [] }, 'six7swe_worker', []),
    ).toThrow(/sequences are missing: jobs_id_seq/);
  });

  it('without a worker, shuts former workers out and grants nothing', () => {
    const none = buildWorkerAccessStatements({ tables, sequences }, null, ['old_worker']);
    expect(none).toContain('ALTER ROLE "old_worker" NOLOGIN;');
    expect(none.some((s) => s.startsWith('GRANT') || s.startsWith('CREATE POLICY'))).toBe(false);
  });
});
