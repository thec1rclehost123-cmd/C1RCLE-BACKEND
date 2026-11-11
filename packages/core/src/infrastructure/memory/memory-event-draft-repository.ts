import type { EntityId } from '../../domain/identity.js';
import type { EventDraft } from '../../domain/models/event-draft.js';
import type { EventDraftRepository } from '../../domain/ports/repositories.js';

function key(userId: string, organizationId: string): string {
  return `${organizationId}:${userId}`;
}

export class MemoryEventDraftRepository implements EventDraftRepository {
  readonly drafts = new Map<string, EventDraft>();

  async getForUserOrganization(userId: EntityId, organizationId: EntityId) {
    return this.drafts.get(key(userId, organizationId)) ?? null;
  }

  async save(draft: EventDraft) {
    this.drafts.set(key(draft.userId, draft.organizationId), structuredClone(draft));
  }

  async deleteForUserOrganization(userId: EntityId, organizationId: EntityId) {
    this.drafts.delete(key(userId, organizationId));
  }
}
