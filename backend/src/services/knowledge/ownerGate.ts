import { UnauthenticatedUser } from '../../constants';
import type { ContextUser } from '../../types';

/**
 * Whether the request user owns the knowledge base: an authenticated user
 * whose verified subject (`authId`, the JWT `sub`) equals `OWNER_AUTH_ID`.
 *
 * The email is never consulted: it is not an identity key (see
 * `domain/jobHunt/identity.ts`). With `OWNER_AUTH_ID` unset nobody is the
 * owner, so the knowledge routes fail closed.
 */
export function isKnowledgeOwner(
  user: ContextUser | undefined,
  ownerAuthId: string | null,
): boolean {
  if (!ownerAuthId || !user || user === UnauthenticatedUser) return false;
  return typeof user.authId === 'string' && user.authId === ownerAuthId;
}
