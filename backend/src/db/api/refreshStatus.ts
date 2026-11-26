import { eq, and, lt, isNull, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../index';
import { refreshStatus, type RefreshStatus as RefreshStatusType } from '../schema/jobHunt';
import { isUniqueViolation } from '../uniqueViolation';
import { ActiveRefreshExistsError } from '../../domain/jobHunt';

export interface RefreshStatusService {
  newProfileRefreshStatus(profileId: number, claimedBy: string): Promise<RefreshStatusType>;
  enqueueRefresh(profileId: number): Promise<RefreshStatusType>;
  claimNextRefresh(claimedBy: string): Promise<RefreshStatusType | null>;
  heartbeatRefresh(id: number, claimedBy: string): Promise<boolean>;
  getRefreshStatus(id: number): Promise<RefreshStatusType | null>;
  getActiveRefreshForProfile(profileId: number): Promise<RefreshStatusType | null>;
  failStaleRefreshes(olderThan: Date, queuedBefore: Date): Promise<number>;
  updateRefreshStatus(
    id: number,
    claimedBy: string,
    options: Partial<Pick<RefreshStatusType, 'status' | 'step' | 'description'>>
  ): Promise<boolean>;
  endSuccess(id: number, claimedBy: string, summary?: string): Promise<boolean>;
  endFailure(id: number, claimedBy: string, error?: string): Promise<boolean>;
}

const isActive = or(eq(refreshStatus.status, 'PENDING'), eq(refreshStatus.status, 'IN_PROGRESS'));

/**
 * Row `id` is still `claimedBy`'s active claim. Every write a run makes is
 * fenced by it, so a run that was reaped (or finished) can never write again.
 */
function heldBy(id: number, claimedBy: string) {
  return and(eq(refreshStatus.id, id), eq(refreshStatus.claimedBy, claimedBy), isActive);
}

/**
 * Inserts an active refresh row for a profile.
 *
 * Throws {@link ActiveRefreshExistsError} when the profile already has an
 * active refresh. The partial unique index on `refresh_status` decides this,
 * so the outcome is correct even when two requests race.
 */
async function insertActiveRefresh(
  profileId: number,
  claim: Pick<RefreshStatusType, 'claimedBy' | 'claimedAt' | 'heartbeatAt'>,
): Promise<RefreshStatusType> {
  // Every refresh_status time is written from here, never by the database's
  // now(), so they all compare in UTC whatever the session time zone.
  const now = new Date();
  try {
    const [row] = await db
      .insert(refreshStatus)
      .values({
        profileId,
        createdAt: now,
        updatedAt: now,
        status: 'PENDING',
        step: 'PENDING',
        description: '',
        ...claim,
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

/**
 * Creates a PENDING refresh row that `claimedBy` runs straight away, so it is
 * claimed (and heartbeating) from the start and never enters the queue.
 * Throws {@link ActiveRefreshExistsError} when the profile already has an
 * active refresh.
 */
export async function newProfileRefreshStatus(
  profileId: number,
  claimedBy: string,
): Promise<RefreshStatusType> {
  const now = new Date();
  return insertActiveRefresh(profileId, { claimedBy, claimedAt: now, heartbeatAt: now });
}

/**
 * Queues a refresh: a PENDING row with no claim, for a worker to claim with
 * {@link claimNextRefresh}. Throws {@link ActiveRefreshExistsError} when the
 * profile already has an active (queued or running) refresh.
 */
export async function enqueueRefresh(profileId: number): Promise<RefreshStatusType> {
  return insertActiveRefresh(profileId, { claimedBy: null, claimedAt: null, heartbeatAt: null });
}

/**
 * Claims the oldest queued refresh for `claimedBy`, or returns null when none
 * is queued. `for update skip locked` makes the claim atomic: concurrent
 * claimers lock different rows, so two replicas never claim the same one.
 * The row stays PENDING until its run reports a step.
 */
export async function claimNextRefresh(claimedBy: string): Promise<RefreshStatusType | null> {
  const now = new Date();
  const [row] = await db
    .update(refreshStatus)
    .set({ claimedBy, claimedAt: now, heartbeatAt: now, updatedAt: now })
    .where(
      eq(
        refreshStatus.id,
        sql`(select ${refreshStatus.id} from ${refreshStatus}
          where ${refreshStatus.status} = 'PENDING' and ${refreshStatus.claimedAt} is null
          order by ${refreshStatus.id}
          limit 1
          for update skip locked)`,
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Records that `claimedBy` is still running the refresh. False when the row
 * is no longer an active claim of `claimedBy` (it finished, or recovery
 * failed it), in which case the runner should stop heartbeating.
 */
export async function heartbeatRefresh(id: number, claimedBy: string): Promise<boolean> {
  const rows = await db
    .update(refreshStatus)
    .set({ heartbeatAt: new Date() })
    .where(heldBy(id, claimedBy))
    .returning({ id: refreshStatus.id });
  return rows.length > 0;
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
 * When the profile's latest refresh (of any outcome, from any process) was
 * started; null when it never had one. The scraper worker's schedule reads
 * it, so a restart does not reset the clock and a user-triggered refresh
 * counts as a run.
 */
export async function getLatestRefreshStartedAt(profileId: number): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: refreshStatus.createdAt })
    .from(refreshStatus)
    .where(eq(refreshStatus.profileId, profileId))
    .orderBy(sql`${refreshStatus.id} desc`)
    .limit(1);
  return row?.createdAt ?? null;
}

/**
 * Fails every active claim whose runner has stopped heartbeating since
 * `olderThan`, whichever process claimed it, so a crashed run never stays
 * active forever. A live run heartbeats, so it is never reaped however long
 * it takes. An unclaimed row is failed too, so it never blocks its profile
 * for good: IN_PROGRESS (from before the queue) once its last write is older
 * than `olderThan`, PENDING (queued, with no worker to claim it) once it was
 * queued before `queuedBefore`.
 */
export async function failStaleRefreshes(olderThan: Date, queuedBefore: Date): Promise<number> {
  const stale = olderThan.toISOString();
  const rows = await db
    .update(refreshStatus)
    .set({
      status: 'FAILED',
      step: 'PENDING',
      description: 'Refresh did not complete; the process running it stopped before it finished.',
      updatedAt: new Date(),
    })
    .where(
      and(
        isActive,
        or(
          and(
            isNotNull(refreshStatus.claimedAt),
            sql`coalesce(${refreshStatus.heartbeatAt}, ${refreshStatus.claimedAt}) < ${stale}`,
          ),
          and(
            isNull(refreshStatus.claimedAt),
            eq(refreshStatus.status, 'IN_PROGRESS'),
            sql`coalesce(${refreshStatus.updatedAt}, ${refreshStatus.createdAt}) < ${stale}`,
          ),
          and(
            isNull(refreshStatus.claimedAt),
            eq(refreshStatus.status, 'PENDING'),
            lt(refreshStatus.createdAt, queuedBefore),
          ),
        ),
      ),
    )
    .returning({ id: refreshStatus.id });

  return rows.length;
}

/**
 * Writes the run's progress; false when the row is no longer `claimedBy`'s
 * active claim. A write is also a heartbeat, so a run is alive while it reports.
 */
export async function updateRefreshStatus(
  id: number,
  claimedBy: string,
  options: Partial<Pick<RefreshStatusType, 'status' | 'step' | 'description'>>
): Promise<boolean> {
  const result = await db
    .update(refreshStatus)
    .set({ ...options, updatedAt: new Date(), heartbeatAt: new Date() })
    .where(heldBy(id, claimedBy))
    .returning({ id: refreshStatus.id });
  return result.length > 0;
}

export async function endSuccess(id: number, claimedBy: string, summary?: string) {
  return updateRefreshStatus(id, claimedBy, {
    status: 'COMPLETED',
    step: 'PENDING',
    description: summary ?? null,
  });
}

export async function endFailure(id: number, claimedBy: string, error?: string) {
  return updateRefreshStatus(id, claimedBy, {
    status: 'FAILED',
    step: 'PENDING',
    description: error ?? null,
  });
}
