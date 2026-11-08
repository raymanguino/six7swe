/**
 * Seeds the job-hunter's reference data: the users and the search profiles
 * that belong to them.
 *
 * This is development data, not personal data, so it is tracked in git.
 * The portfolio seed (personal details and resume text) is separate and
 * lives in scripts/seed-portfolio.ts, which is gitignored.
 *
 * Idempotent: running it again updates the existing rows rather than
 * failing on the unique constraints.
 *
 * Requires: DATABASE_URL.
 */

import { eq } from 'drizzle-orm';
import { resolveDatabaseTarget } from './db-env';

interface SeedUser {
  name: string;
  email: string;
}

interface SeedProfile {
  /** The email of the owning user. */
  userEmail: string;
  name: string;
  keywords: string[];
  /**
   * The LinkedIn numeric region id.
   *
   * Not a city name: a city name produces a search that silently returns
   * nothing. See src/domain/jobHunt/jobs.ts.
   */
  location: string;
  additionalContext: string;
  resume: string;
}

const SEED_USERS: SeedUser[] = [
  { name: 'John Doe', email: 'john@example.com' },
  { name: 'Jane Smith', email: 'jane@example.com' },
];

const SEED_PROFILES: SeedProfile[] = [
  {
    userEmail: 'john@example.com',
    name: 'default',
    keywords: ['Software', 'Engineer'],
    location: '105149290',
    additionalContext: 'Software Engineer',
    resume: 'John Doe Resume',
  },
  {
    userEmail: 'john@example.com',
    name: 'Product Manager Profile',
    keywords: ['Product', 'Manager'],
    location: '105149290',
    additionalContext: 'Product Manager',
    resume: 'John Doe Resume',
  },
  {
    userEmail: 'jane@example.com',
    name: 'default',
    keywords: ['Software', 'Engineer'],
    location: '101174742',
    additionalContext: 'Software Engineer',
    resume: 'Jane Smith Resume',
  },
];

/**
 * Creates the seeded users and profiles.
 *
 * Users are matched by email, profiles by (user, name), so re-running this
 * against a populated database is safe.
 *
 * The Drizzle client is imported lazily so the caller controls when it is
 * created: it binds to DATABASE_URL when first loaded, which has to happen
 * after the env file for the selected target is read.
 */
export async function seedJobHuntData(): Promise<{ users: number; profiles: number }> {
  const { db } = await import('../src/db');
  const { profiles, users } = await import('../src/db/schema');

  for (const seedUser of SEED_USERS) {
    await db
      .insert(users)
      .values({ name: seedUser.name, email: seedUser.email })
      .onConflictDoUpdate({
        target: users.email,
        set: { name: seedUser.name, updatedAt: new Date() },
      });
  }

  for (const seedProfile of SEED_PROFILES) {
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, seedProfile.userEmail))
      .limit(1);

    if (!owner) {
      throw new Error(`Seed user ${seedProfile.userEmail} was not created`);
    }

    await db
      .insert(profiles)
      .values({
        userId: owner.id,
        name: seedProfile.name,
        keywords: seedProfile.keywords,
        location: seedProfile.location,
        additionalContext: seedProfile.additionalContext,
        resume: seedProfile.resume,
      })
      .onConflictDoUpdate({
        target: [profiles.userId, profiles.name],
        set: {
          keywords: seedProfile.keywords,
          location: seedProfile.location,
          additionalContext: seedProfile.additionalContext,
          resume: seedProfile.resume,
          updatedAt: new Date(),
        },
      });
  }

  return { users: SEED_USERS.length, profiles: SEED_PROFILES.length };
}

// Run directly: `pnpm run db:seed`
if (require.main === module) {
  try {
    resolveDatabaseTarget();
  } catch (error) {
    process.stderr.write(
      `Seeding failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }

  seedJobHuntData()
    .then((result) => {
      process.stdout.write(
        `Seeded ${result.users} user(s) and ${result.profiles} profile(s).\n`,
      );
      process.exit(0);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `Seeding failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
