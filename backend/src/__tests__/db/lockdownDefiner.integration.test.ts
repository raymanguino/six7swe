/**
 * A SECURITY DEFINER routine in `public` that the owner cannot revoke (it
 * belongs to another role) fails the lockdown while the browser roles can
 * execute it, and is only reported once it is not a definer.
 */

import { applyLockdown } from '../../../scripts/db-lockdown';
import { credentials, describeWithDatabase, runSuffix, useTestDatabase } from './lockdownDatabase';

describeWithDatabase('an unmanaged SECURITY DEFINER routine', () => {
  const suffix = runSuffix();
  const app = credentials(`six7swe_lt_d_${suffix}`);
  const bystander = credentials(`six7swe_lt_di_${suffix}`);
  const db = useTestDatabase(
    `six7swe_lockdown_definer_test_${suffix}`,
    'create table public.items (id serial primary key);',
    [bystander],
    [app, bystander],
  );

  it('fails on an exposed SECURITY DEFINER routine the owner cannot revoke', async () => {
    // Created by the bystander itself: `GRANT <role> TO current_user` segfaults local Supabase.
    await db.owner.unsafe(`grant create on schema public to "${bystander.role}"`);
    await db.asRole(bystander, (sql) =>
      sql.unsafe(
        "create function public.foreign_definer() returns int language sql security definer as 'select 1'",
      ),
    );
    await db.owner.unsafe(`revoke create on schema public from "${bystander.role}"`);
    await expect(applyLockdown(db.owner, app)).rejects.toThrow(
      `owner ${bystander.role}; executable by anon, authenticated, PUBLIC): as ${bystander.role}, ` +
        'run REVOKE EXECUTE ON FUNCTION public.foreign_definer() FROM anon, authenticated, PUBLIC;',
    );
    // Once it is not a definer, it is only reported.
    await db.asRole(
      bystander,
      (sql) => sql`alter function public.foreign_definer() security invoker`,
    );
    const result = await applyLockdown(db.owner, app);
    expect(result.skippedFunctions).toEqual([
      { signature: 'foreign_definer()', owner: bystander.role, extension: null, definer: false },
    ]);
  }, 30_000);
});
