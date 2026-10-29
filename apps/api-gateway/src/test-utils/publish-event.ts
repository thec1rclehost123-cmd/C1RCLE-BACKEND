import { transitionEvent } from '@c1rcle/core/domain';

import { createV2Services } from '../lib/v2-services.js';

/**
 * Test double: puts a freshly created (draft) event on sale. Online ticket sales
 * require a published event, and the partner routes create drafts, so a fixture
 * that goes on to sell tickets calls this once after creating its event.
 */
export async function publishEventForTest(eventId: string): Promise<void> {
  const events = createV2Services().repos().events;
  const stored = await events.getById(eventId);
  if (!stored) throw new Error(`publishEventForTest: event ${eventId} does not exist`);

  let event = stored;
  for (const to of ['review', 'scheduled', 'published'] as const) {
    event = transitionEvent(event, to);
  }
  // Saves are compare-and-set on the stored version, so land exactly one version
  // ahead no matter how many transitions were applied.
  await events.save({ ...event, version: stored.version + 1 });
}
