import { db, users, profiles, type InsertUser, type InsertProfile } from './';
import { eq, and } from 'drizzle-orm';

/**
 * Example file demonstrating how to use Drizzle ORM with the six7swe project
 * 
 * This file shows various database operations using type-safe Drizzle queries.
 * Works with both Postgres and Supabase - just change DATABASE_MODE in .env
 */

// ============================================================
// CREATE (INSERT) OPERATIONS
// ============================================================

export async function createUser(name: string, email: string) {
  const newUser: InsertUser = {
    name,
    email,
  };

  const [user] = await db
    .insert(users)
    .values(newUser)
    .returning();

  return user;
}

export async function createProfile(userId: number, name: string, location?: string, resume?: string) {
  const newProfile: InsertProfile = {
    userId,
    name,
    location,
    resume,
    keywords: ['Software', 'Engineer'], // Example keywords array
  };

  const [profile] = await db
    .insert(profiles)
    .values(newProfile)
    .returning();

  return profile;
}

// ============================================================
// READ (SELECT) OPERATIONS
// ============================================================

export async function getAllUsers() {
  return await db.select().from(users);
}

export async function getUserById(id: number) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, id));

  return user;
}

export async function getUserByEmail(email: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email));

  return user;
}

export async function getProfilesByUserId(userId: number) {
  return await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId));
}

export async function getUserWithProfiles(userId: number) {
  // Join example: Get user with all their profiles
  const result = await db
    .select({
      userId: users.id,
      userName: users.name,
      userEmail: users.email,
      profileId: profiles.id,
      profileName: profiles.name,
      profileLocation: profiles.location,
    })
    .from(users)
    .leftJoin(profiles, eq(users.id, profiles.userId))
    .where(eq(users.id, userId));

  return result;
}

// ============================================================
// UPDATE OPERATIONS
// ============================================================

export async function updateUserName(id: number, newName: string) {
  const [updated] = await db
    .update(users)
    .set({ 
      name: newName,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id))
    .returning();

  return updated;
}

export async function updateProfile(
  id: number, 
  updates: Partial<Omit<InsertProfile, 'userId'>>
) {
  const [updated] = await db
    .update(profiles)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(eq(profiles.id, id))
    .returning();

  return updated;
}

// ============================================================
// DELETE OPERATIONS
// ============================================================

export async function deleteUser(id: number) {
  // This will also delete all associated profiles due to CASCADE
  const [deleted] = await db
    .delete(users)
    .where(eq(users.id, id))
    .returning();

  return deleted;
}

export async function deleteProfile(id: number) {
  const [deleted] = await db
    .delete(profiles)
    .where(eq(profiles.id, id))
    .returning();

  return deleted;
}

// ============================================================
// COMPLEX QUERIES
// ============================================================

export async function getUserProfile(userId: number, profileName: string) {
  const [profile] = await db
    .select()
    .from(profiles)
    .where(
      and(
        eq(profiles.userId, userId),
        eq(profiles.name, profileName)
      )
    );

  return profile;
}

// ============================================================
// EXAMPLE USAGE
// ============================================================

async function exampleUsage() {
  try {
    // Create a new user
    const user = await createUser('Alice Johnson', 'alice@example.com');
    console.log('Created user:', user);

    // Create a profile for the user
    const profile = await createProfile(
      user.id,
      'Senior Developer',
      'San Francisco, CA',
      'Experienced full-stack developer...'
    );
    console.log('Created profile:', profile);

    // Get all users
    const allUsers = await getAllUsers();
    console.log('All users:', allUsers);

    // Get user with their profiles
    const userWithProfiles = await getUserWithProfiles(user.id);
    console.log('User with profiles:', userWithProfiles);

    // Update user name
    const updatedUser = await updateUserName(user.id, 'Alice Johnson-Smith');
    console.log('Updated user:', updatedUser);

    // Clean up
    await deleteUser(user.id);
    console.log('Deleted user and associated profiles');

  } catch (error) {
    console.error('Error in example usage:', error);
  }
}

// Uncomment to run examples:
// exampleUsage();
