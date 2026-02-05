// Simple test to verify Drizzle + Supabase connection
import 'dotenv/config';
import { db, users } from './src/db';

async function testConnection() {
  try {
    console.log('Testing Drizzle + Supabase connection...');
    console.log('Database Mode:', process.env.DATABASE_MODE);
    
    // Query all users
    const allUsers = await db.select().from(users);
    
    console.log('✅ Connection successful!');
    console.log('Users found:', allUsers.length);
    console.log('Users:', JSON.stringify(allUsers, null, 2));
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Connection failed:', error);
    process.exit(1);
  }
}

testConnection();
