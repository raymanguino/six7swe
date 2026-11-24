import { dropMigrationUrl, MIGRATION_URL_VARIABLE } from '../../config/migrationUrl';

describe('dropMigrationUrl', () => {
  it('removes the owner connection and reports that it was set', () => {
    const env: Record<string, string | undefined> = {
      DATABASE_URL: 'postgres://six7swe_app:pw@host/db',
      [MIGRATION_URL_VARIABLE]: 'postgres://postgres:ownerpw@host/db',
    };

    expect(dropMigrationUrl(env)).toBe(true);
    expect(env).not.toHaveProperty(MIGRATION_URL_VARIABLE);
    expect(env.DATABASE_URL).toBe('postgres://six7swe_app:pw@host/db');
  });

  it('reports false when the variable was not set', () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: 'postgres://u:p@host/db' };
    expect(dropMigrationUrl(env)).toBe(false);
  });

  it('removes it from process.env, which child processes such as Chrome inherit', () => {
    process.env[MIGRATION_URL_VARIABLE] = 'postgres://postgres:ownerpw@host/db';
    expect(dropMigrationUrl()).toBe(true);
    expect(process.env[MIGRATION_URL_VARIABLE]).toBeUndefined();
  });
});
