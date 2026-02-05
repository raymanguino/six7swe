import { Client } from 'pg';
import { RefreshStatus } from '../../types';

export interface RefreshStatusService {
  newProfileRefreshStatus(client: Client, profileId: number): Promise<RefreshStatus>;
  getRefreshStatus(client: Client, id: number): Promise<RefreshStatus>;

  // Update any combination of status, step, description provided in options.
  // If unspecified, that field is not updated.
  updateRefreshStatus(client: Client, id: number, options: Partial<RefreshStatus>): Promise<boolean>;

  endSuccess(client: Client, id: number, summary?: string): Promise<boolean>;
  endFailure(client: Client, id: number, error?: string): Promise<boolean>;
}

export async function newProfileRefreshStatus(
  client: Client,
  profileId: number
): Promise<RefreshStatus> {
  const { rows } = await client.query(`
    INSERT INTO refresh_status (profile_id, status, step, description, created_at, updated_at) 
    VALUES ($1, 'PENDING', 'PENDING', '', NOW(), NOW()) 
    RETURNING *
  `, [profileId]);

  return rows[0];
}

export async function getRefreshStatus(
  client: Client,
  id: number
): Promise<RefreshStatus> {
  const { rows } = await client.query(`
    SELECT * 
    FROM refresh_status 
    WHERE id = $1
  `, [id]);

  return rows[0];
}

export async function updateRefreshStatus(
  client: Client,
  id: number,
  options: Partial<RefreshStatus>
): Promise<boolean> {
  const fields = [];
  const values = [];
  let idx = 1;

  if (options.status !== undefined) {
    fields.push(`status = $${idx++}`);
    values.push(options.status);
  }
  if (options.step !== undefined) {
    fields.push(`step = $${idx++}`);
    values.push(options.step);
  }
  if (options.description !== undefined) {
    fields.push(`description = $${idx++}`);
    values.push(options.description);
  }

  if (fields.length === 0) {
    // Nothing to update
    return false;
  }

  fields.push(`updated_at = NOW()`);

  const { rowCount } = await client.query(`
    UPDATE refresh_status 
    SET ${fields.join(', ')}
    WHERE id = ${id}
  `, values);

  return (rowCount ?? 0) > 0;
}

export async function endSuccess(
  client: Client,
  id: number,
  summary?: string,
): Promise<void> {
  await client.query(`
    UPDATE refresh_status 
    SET status = 'COMPLETED', step = 'PENDING', description = $2, updated_at = NOW() 
    WHERE id = $1
  `, [id, summary]);
}
  
export async function endFailure(
  client: Client,
  id: number,
  error?: string
): Promise<void> {
  await client.query(`
    UPDATE refresh_status 
    SET status = 'FAILED', step = 'PENDING', description = $2, updated_at = NOW() 
    WHERE id = $1
  `, [id, error]);
}
