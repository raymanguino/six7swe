import { eq, and, lt, isNull, or, sql } from 'drizzle-orm';
import { db } from '../index';
import { refreshStatus, type RefreshStatus as RefreshStatusType } from '../schema/jobHunt';
import { ActiveRefreshExistsError } from '../../domain/jobHunt';

/** Postgres error code for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * True when the error is a unique constraint violation.
 *
 * The insert races are resolved by the database, so this is how the service
 * learns that another refresh won.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === UNIQUE_VIOLATION;
}

export interface RefreshStatusService {
  newProfileRefreshStatus(profileId: number): Promise<RefreshStatusType>;
  getRefreshStatus(id: number): Promise<RefreshStatusType | null>;
  getActiveRefreshForProfile(profileId: number): Promise<RefreshStatusType | null>;
  failStaleRefreshes(olderThan: Date): Promise<number>;
  updateRefreshStatus(
    id: number,
    options: Partial<Pick<RefreshStatusType, 'status' | 'step' | 'description'>>
  ): Promise<boolean>;
  endSuccess(id: number, summary?: string): Promise<void>;
  endFailure(id: number, error?: string): Promise<void>;
}

/**
 * Creates a PENDING refresh row for a profile.
 *
 * Throws {@link ActiveRefreshExistsError} when the profile already has an
 * active refresh. The partial unique index on `refresh_status` decides this,
 * so the outcome is correct even when two requests race.
 */
export async function newProfileRefreshStatus(
  profileId: number
): Promise<RefreshStatusType> {
  try {
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
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ActiveRefreshExistsError(profileId);
    }
    throw error;
  }
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

/**
 * Returns the refresh that is currently running for a profile, if any.
 *
 * Used to reject a second concurrent refresh for the same profile.
 */
export async function getActiveRefreshForProfile(
  profileId: number
): Promise<RefreshStatusType | null> {
  const [row] = await db
    .select()
    .from(refreshStatus)
    .where(
      and(
        eq(refreshStatus.profileId, profileId),
        or(
          eq(refreshStatus.status, 'PENDING'),
          eq(refreshStatus.status, 'IN_PROGRESS'),
        ),
      ),
    )
    .orderBy(sql`${refreshStatus.id} desc`)
    .limit(1);
  return row ?? null;
}

/**
 * Marks refreshes that have been running longer than `olderThan` as FAILED.
 *
 * A process restart mid-refresh leaves a row stuck in IN_PROGRESS forever.
 * Reaping stale rows on startup keeps the status honest.
 */
export async function failStaleRefreshes(olderThan: Date): Promise<number> {
  const rows = await db
    .update(refreshStatus)
    .set({
      status: 'FAILED',
      step: 'PENDING',
      description: 'Refresh did not complete; the process restarted before it finished.',
      updatedAt: new Date(),
    })
    .where(
      and(
        or(
          eq(refreshStatus.status, 'IN_PROGRESS'),
          eq(refreshStatus.status, 'PENDING'),
        ),
        or(
          lt(refreshStatus.updatedAt, olderThan),
          and(isNull(refreshStatus.updatedAt), lt(refreshStatus.createdAt, olderThan)),
        ),
      ),
    )
    .returning({ id: refreshStatus.id });

  return rows.length;
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
