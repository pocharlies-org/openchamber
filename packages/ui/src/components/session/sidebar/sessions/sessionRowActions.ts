import type { Session } from '@/lib/opencode/model';
import { isArchivedSession } from '@/stores/globalSessions';

/**
 * Whether a session row should offer "Restore" instead of "Archive".
 *
 * `archivedBucket` says where the row is drawn (the Archive view), not whether
 * the session is archived: the project groups mix active and archived rows, so
 * branching on the bucket alone made an archived row offer to archive itself a
 * second time and never offer to come back.
 */
export const rowOffersRestore = (args: { archivedBucket: boolean; session: Session }): boolean => (
  args.archivedBucket || isArchivedSession(args.session)
);
