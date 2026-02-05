/**
 * Quick test script to verify Drizzle ORM connection
 * 
 * Run with: npx ts-node src/db/test-connection.ts
 * Or: npx tsx src/db/test-connection.ts
 */

import 'dotenv/config';
import { db, users, profiles } from './index';

async function testConnection() {
  console.log('🔍 Testing Drizzle ORM connection...\n');
  console.log(`📊 Database Mode: ${process.env.DATABASE_MODE || 'postgres'}\n`);

  try {
    // Test 1: Fetch all users
    console.log('Test 1: Fetching all users...');
    const allUsers = await db.select().from(users);
    console.log(`✅ Found ${allUsers.length} users:`);
    allUsers.forEach(user => {
      console.log(`   - ${user.name} (${user.email})`);
    });

    // Test 2: Fetch all profiles
    console.log('\nTest 2: Fetching all profiles...');
    const allProfiles = await db.select().from(profiles);
    console.log(`✅ Found ${allProfiles.length} profiles:`);
    allProfiles.forEach(profile => {
      console.log(`   - User ${profile.userId}: ${profile.name}`);
    });

    // Test 3: Join query - users with profiles
    console.log('\nTest 3: Testing join query...');
    const { eq: eqOp } = await import('drizzle-orm');
    const usersWithProfiles = await db
      .select({
        userName: users.name,
        userEmail: users.email,
        profileName: profiles.name,
        profileLocation: profiles.location,
      })
      .from(users)
      .leftJoin(profiles, eqOp(users.id, profiles.userId));
    
    console.log(`✅ Join query successful, returning ${usersWithProfiles.length} rows`);

    console.log('\n✅ All tests passed! Drizzle ORM is working correctly.\n');
    
  } catch (error) {
    console.error('❌ Connection test failed:', error);
    process.exit(1);
  }
}

testConnection()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
