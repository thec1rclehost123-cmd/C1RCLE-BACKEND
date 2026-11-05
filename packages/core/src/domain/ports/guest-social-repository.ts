import type { GuestSocialPrivacy } from '../models/guest-social.js';

/** Social consent only. Never mutates operational events, tickets or identity. */
export interface GuestSocialRepository {
  getPrivacy(userId: string): Promise<GuestSocialPrivacy | null>;
  savePrivacy(userId: string, privacy: GuestSocialPrivacy): Promise<void>;
  eventEnabled(eventId: string): Promise<boolean>;
  setEventEnabled(eventId: string, enabled: boolean): Promise<void>;
  eventHidden(userId: string, eventId: string): Promise<boolean>;
  setEventHidden(userId: string, eventId: string, hidden: boolean): Promise<void>;
  hiddenEvents(userId: string): Promise<string[]>;
  blockedEitherWay(first: string, second: string): Promise<boolean>;
  setBlocked(
    userId: string,
    targetId: string,
    blocked: boolean,
    displayName?: string,
  ): Promise<void>;
  blockedBy(userId: string): Promise<{ id: string; displayName: string }[]>;
}
