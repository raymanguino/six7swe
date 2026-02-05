import { Client } from 'pg';
import { Profile } from '../../types';

export interface ProfileService {
  getAllProfiles(client: Client): Promise<Profile[]>;
  getProfileById(client: Client, id: number): Promise<Profile | null>;
  getProfileByName(client: Client, name: string): Promise<Profile | null>;
}

export async function getAllProfiles(
  client: Client
): Promise<Profile[]> {
  const { rows } = await client.query(`
    SELECT * 
    FROM profiles
    ORDER BY id
  `);

  return rows;
}

export async function getProfileById(
  client: Client,
  id: number,
): Promise<Profile | null> {
  const { rows } = await client.query(`
    SELECT * 
    FROM profiles
    WHERE id = $1
  `, [id]);

  if (rows.length === 0) {
    return null;
  }

  return rows[0];
}

export async function getProfileByName(
  client: Client,
  name: string
): Promise<Profile | null> {
  const { rows } = await client.query(`
    SELECT profiles.*
    FROM profiles
    WHERE profile.name = $1;
  `, [name]);

  if (rows.length === 0) {
    return null;
  }

  return rows[0];
}
