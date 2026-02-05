import { Client } from 'pg';
import { User } from '../../types';

export interface UserService {
  getAllUsers(client: Client): Promise<User[]>;
  getUserById(client: Client, id: number): Promise<User>;
  getUserByEmail(client: Client, email: string): Promise<User>;
}

export async function getAllUsers(
  client: Client,
): Promise<User[]> {
  const { rows } = await client.query(`
    SELECT * 
    FROM users 
    ORDER BY id
  `);

  return rows;
}

export async function getUserById(
  client: Client, 
  id: number
): Promise<User> {
  const { rows } = await client.query(`
    SELECT * FROM users 
    WHERE id = $1
  `, [id]);

  if (rows.length === 0) {
    throw new Error('User not found');
  }

  return rows[0];
}

export async function getUserByEmail(
  client: Client, 
  email: string
): Promise<User> {
  const { rows } = await client.query(`
    SELECT * FROM users 
    WHERE email = $1
  `, [email]);

  if (rows.length === 0) {
    throw new Error('User not found');
  }

  return rows[0];
}
