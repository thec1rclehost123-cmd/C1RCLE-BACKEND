import type { EntityId } from '../identity.js';

/** One resumable Host editor draft per authenticated user and organization. */
export interface EventDraft {
  readonly id: string;
  readonly userId: EntityId;
  readonly organizationId: EntityId;
  readonly schemaVersion: 1;
  readonly data: Record<string, unknown>;
  readonly updatedAt: string;
}
