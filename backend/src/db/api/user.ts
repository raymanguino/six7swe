import { eq, asc } from 'drizzle-orm';
import { db } from '../index';
import { users, type User } from '../schema';

export interface UserService {
  getAllUsers(): Promise<User[]>;
  getUserById(id: number): Promise<User>;
  getUserByEmail(email: string): Promise<User>;
}

export async function getAllUsers(): Promise<User[]> {
  return await db.select().from(users).orderBy(asc(users.id));
}

export async function getUserById(id: number): Promise<User> {
  const [user] = await db.select().from(users).where(eq(users.id, id));
  if (!user) {
    throw new Error('User not found');
  }
  return user;
}

export async function getUserByEmail(email: string): Promise<User> {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    throw new Error('User not found');
  }
  return user;
}
