/**
 * ─── Application-layer barrel ─────────────────────────────────────────────────
 * Single entrypoint for the V2 partners-slice application services. The
 * Fastify v2 routes depend on this barrel (plus `ServiceDeps`) — never on
 * individual files or on infra. Zero Fastify/Firestore imports in this subtree.
 */

export * from './context.js';
export { OrganizationService } from './organizations/organization-service.js';
export type {
  CreateOrganizationCommand,
  InviteMemberCommand,
  UpdateOrganizationCommand,
} from './organizations/organization-service.js';
export {
  VenueService,
  VenueCalendarService,
  VenueSlotRequestService,
} from './venues/venue-service.js';
export type { CreateVenueCommand, UpdateVenueCommand } from './venues/venue-service.js';
export { EventService } from './events/event-service.js';
export type { CreateEventCommand, UpdateEventCommand } from './events/event-service.js';
export { EventCatalogService } from './event-catalog/event-catalog-service.js';
export type {
  CreateTierCommand,
  CreatePromotionCommand,
  CreateTableCommand,
  AssignPromoterCommand,
  CommissionTerms,
} from './event-catalog/event-catalog-service.js';
export { PromoterConnectionService } from './promoters/promoter-connection-service.js';
export type { RequestConnectionCommand } from './promoters/promoter-connection-service.js';
export { ReferralLinkService } from './promoters/referral-link-service.js';
export type { CreateReferralLinkCommand } from './promoters/referral-link-service.js';
export { PartnershipService } from './partnerships/partnership-service.js';
export type { RequestPartnershipCommand } from './partnerships/partnership-service.js';
export { PublicService } from './public/public-service.js';
export { AdminAuthorityService } from './admin/admin-authority-service.js';
export type { ProposeCommand, AuditInput } from './admin/admin-authority-service.js';
export { OnboardingService } from './onboarding/onboarding-service.js';
export type {
  StartApplicationCommand,
  AddDocumentCommand,
  VerifyDocumentCommand,
  ReviewCommand,
} from './onboarding/onboarding-service.js';
export { AnalyticsService } from './analytics/analytics-service.js';
export { IdempotencyService } from './idempotency/idempotency-service.js';
export type { IdempotentCommand, IdempotentResult } from './idempotency/idempotency-service.js';
export { InProcessEventBus } from './events/event-bus.js';
export type { EventHandler } from './events/event-bus.js';
export { createAuditConsumer, createProjectionConsumer } from './events/audit-consumers.js';

// Phase 4: Checkout, Inventory, Payments
export { CheckoutService } from './checkout/checkout-service.js';
export { InventoryService } from './inventory/inventory-service.js';
export { PricingService } from './pricing/pricing-service.js';
export { OrderService } from './orders/order-service.js';
export { TicketService } from './tickets/ticket-service.js';

// Phase 5: Scanner, Door, Cover Wallet
export type {
  ScannerService,
  ScannerServiceDeps,
  ScanTicketInput,
  ScanMagicTicketInput,
  ScanResult,
  ResolveTicketInput,
  ResolveMagicTicketInput,
  TicketResolution,
} from './scanner/scanner-service.js';
export { createScannerService } from './scanner/scanner-service.js';
export type {
  DoorService,
  DoorServiceDeps,
  CreateWalkInInput,
  CreateDineInInput,
  DoorSaleFilters,
  DoorSaleStats,
} from './door/door-service.js';
export { createDoorService } from './door/door-service.js';
export type {
  CoverWalletService,
  CoverWalletServiceDeps,
  CreateWalletInput,
  CreditWalletInput,
  DebitWalletInput,
  RefundWalletInput,
  AdjustWalletInput,
  WalletFilters,
  TxnFilters,
  RunReconciliationInput,
  ReconciliationFilters,
  WalletEventStats,
  WalletOrgStats,
} from './cover-wallet/cover-wallet-service.js';
export { createCoverWalletService } from './cover-wallet/cover-wallet-service.js';
export type {
  DoorStatsService,
  DoorStatsServiceDeps,
  DoorStats,
} from './door/door-stats-service.js';
export { createDoorStatsService } from './door/door-stats-service.js';
export type {
  FinanceService,
  FinanceServiceDeps,
  RecordTicketSaleInput,
  BalanceSummary,
} from './finance/finance-service.js';
export { createFinanceService } from './finance/finance-service.js';
export type {
  PayoutService,
  PayoutServiceDeps,
  RequestPayoutInput,
} from './finance/payout-service.js';
export { createPayoutService } from './finance/payout-service.js';
export type {
  BankAccountService,
  BankAccountServiceDeps,
  AddBankAccountInput,
} from './finance/bank-account-service.js';
export { createBankAccountService } from './finance/bank-account-service.js';
export type {
  DisputeService,
  DisputeServiceDeps,
  RaiseDisputeInput,
} from './finance/dispute-service.js';
export { createDisputeService } from './finance/dispute-service.js';
export type { RequestRefundCommand } from './finance/refund-service.js';
export { RefundService } from './finance/refund-service.js';
export type { LeaderboardService, LeaderboardServiceDeps } from './finance/leaderboard-service.js';
export { createLeaderboardService } from './finance/leaderboard-service.js';
export type { EmailOtpService, EmailOtpServiceDeps } from './auth/email-otp-service.js';
export { createEmailOtpService } from './auth/email-otp-service.js';
