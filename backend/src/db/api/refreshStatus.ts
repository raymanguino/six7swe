import { eq } from 'drizzle-orm';
import { db } from '../index';
import { refreshStatus, type RefreshStatus as RefreshStatusType } from '../schema';

export interface RefreshStatusService {
  newProfileRefreshStatus(profileId: number): Promise<RefreshStatusType>;
  getRefreshStatus(id: number): Promise<RefreshStatusType | null>;
  updateRefreshStatus(
    id: number,
    options: Partial<Pick<RefreshStatusType, 'status' | 'step' | 'description'>>
  ): Promise<boolean>;
  endSuccess(id: number, summary?: string): Promise<void>;
  endFailure(id: number, error?: string): Promise<void>;
}

export async function newProfileRefreshStatus(
  profileId: number
): Promise<RefreshStatusType> {
  const [row] = await db
    .insert(refreshStatus)
    .values({
      profileId,
      status: 'PENDING',
      step: 'PENDING',
      description: '',
    })
    .returning();
  if (!row) {
    throw new Error('Failed to create refresh status');
  }
  return row;
}

export async function getRefreshStatus(
  id: number
): Promise<RefreshStatusType | null> {
  const [row] = await db
    .select()
    .from(refreshStatus)
    .where(eq(refreshStatus.id, id));
  return row ?? null;
}

export async function updateRefreshStatus(
  id: number,
  options: Partial<Pick<RefreshStatusType, 'status' | 'step' | 'description'>>
): Promise<boolean> {
  const hasUpdates =
    options.status !== undefined ||
    options.step !== undefined ||
    options.description !== undefined;
  if (!hasUpdates) {
    return false;
  }
  const updates: Partial<RefreshStatusType> = {
    ...options,
    updatedAt: new Date(),
  };
  const result = await db
    .update(refreshStatus)
    .set(updates)
    .where(eq(refreshStatus.id, id))
    .returning({ id: refreshStatus.id });
  return result.length > 0;
}

export async function endSuccess(
  id: number,
  summary?: string
): Promise<void> {
  await db
    .update(refreshStatus)
    .set({
      status: 'COMPLETED',
      step: 'PENDING',
      description: summary ?? null,
      updatedAt: new Date(),
    })
    .where(eq(refreshStatus.id, id));
}

export async function endFailure(id: number, error?: string): Promise<void> {
  await db
    .update(refreshStatus)
    .set({
      status: 'FAILED',
      step: 'PENDING',
      description: error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(refreshStatus.id, id));
}
