export interface GuestSocialPrivacy {
  profileVisible: boolean;
  showOnGuestlists: boolean;
  showUpcomingEvents: boolean;
}
export const PRIVATE_GUEST_SOCIAL: Readonly<GuestSocialPrivacy> = {
  profileVisible: false,
  showOnGuestlists: false,
  showUpcomingEvents: false,
};
export interface SocialGuestIdentity {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  interests: string[];
}
export interface SocialEventSummary {
  id: string;
  slug: string;
  title: string;
  startAt: string;
  imageUrl: string | null;
}
