/**
 * ─── Root exports ────────────────────────────────────────────────────────────
 * Re-exports all contract types and utilities.
 * Source of truth is in ./contracts/ directory (modular monolith structure).
 */

// Re-export everything from client.ts (which re-exports from modular contracts)
export * from './client.js';

// Error envelope utilities (from shared)
export { 
  buildErrorResponse, 
  buildSuccessResponse, 
  buildValidationDetails, 
  errorCodeForStatus, 
  buildV2ErrorResponse, 
  zodToFieldErrors, 
  STATUS_CODE_TO_ERROR_CODE 
} from './contracts/shared.js';
export type {
  OrganizationRoleDto,
  OrganizationStatusDto,
  OrganizationDto,
  CreateOrganizationInput,
  VenueStatusDto,
  VenueDto,
  CreateVenueInput,
  OrganizationMemberDto,
  InviteMemberInput,
  VenueProfileDto,
  VenueSlotDto,
  SlotRequestDto,
  CreateSlotRequestInput,
} from './contracts/organization.js';

export {
  organizationRoleSchema,
  organizationStatusSchema,
  organizationDtoSchema,
  createOrganizationSchema,
  venueStatusSchema,
  venueDtoSchema,
  createVenueSchema,
  organizationMemberDtoSchema,
  inviteMemberSchema,
  venueProfileDtoSchema,
  venueSlotDtoSchema,
  slotRequestDtoSchema,
  createSlotRequestSchema,
} from './contracts/organization.js';

// Event + Catalog
export type {
  EventStatusDto,
  EventDto,
  EventPreviewDto,
  CreateEventInput,
  UpdateEventInput,
  CancelEventInput,
  TicketTierDto,
  CreateTicketTierRequest,
  PromoCodeDto,
  CreatePromoCodeRequest,
  TablePackageDto,
  CreateTablePackageRequest,
  PromoterAssignmentDto,
  AssignPromoterRequest,
} from './contracts/event.js';

export {
  eventStatusSchema,
  eventDtoSchema,
  eventPreviewDtoSchema,
  createEventSchema,
  updateEventSchema,
  cancelEventSchema,
  ticketTierStatusSchema,
  ticketTierDtoSchema,
  createTicketTierSchema,
  promoCodeDtoSchema,
  createPromoCodeSchema,
  tablePackageDtoSchema,
  createTablePackageSchema,
  promoterAssignmentDtoSchema,
  assignPromoterSchema,
} from './contracts/event.js';

// Partner (partnerships, promoters, referrals, analytics)
export type {
  PartnershipDto,
  RequestPartnershipRequest,
  ResolvePartnershipRequest,
  PartnerAccessDto,
  OrganizationOverviewDto,
  EventAnalyticsDto,
  ReferralLinkDto,
  CreateReferralLinkRequest,
  PromoterConnectionDto,
  RequestConnectionRequest,
} from './contracts/partner.js';

export {
  partnershipStatusSchema,
  partnershipDtoSchema,
  requestPartnershipSchema,
  resolvePartnershipSchema,
  partnerPermissionSchema,
  partnerAccessDtoSchema,
  organizationOverviewDtoSchema,
  eventAnalyticsDtoSchema,
  referralLinkDtoSchema,
  createReferralLinkSchema,
  promoterConnectionDtoSchema,
  requestConnectionSchema,
} from './contracts/partner.js';

// Onboarding / KYC / Admin Authority
export type {
  OnboardingProfileDto,
  OnboardingRequestDto,
  StartOnboardingRequest,
  SaveOnboardingProgressRequest,
  AddOnboardingDocumentRequest,
  VerifyDocumentRequest,
  VerificationResultDto,
  ReviewOnboardingRequest,
  ProvisionedOrganizationDto,
  ApproveOnboardingResult,
  PlatformAdminDto,
  ProposedActionDto,
  ProposeActionRequest,
  ResolveProposalRequest,
  AdminAuditRecordDto,
} from './contracts/onboarding.js';

export {
  onboardingStatusSchema,
  onboardingPlanSchema,
  onboardingProfileSchema,
  onboardingDocumentSchema,
  onboardingRequestDtoSchema,
  startOnboardingSchema,
  saveOnboardingProgressSchema,
  addOnboardingDocumentSchema,
  verifyDocumentSchema,
  verificationResultDtoSchema,
  reviewOnboardingSchema,
  provisionedOrganizationDtoSchema,
  approveOnboardingResultSchema,
  adminRoleSchema,
  adminActionSchema,
  proposalStatusSchema,
  platformAdminDtoSchema,
  proposedActionDtoSchema,
  proposeActionSchema,
  resolveProposalSchema,
  adminAuditRecordDtoSchema,
} from './contracts/onboarding.js';

// Checkout / Orders / Payments / Entitlements
export type {
  CheckoutQuoteRequest,
  CheckoutQuoteResponse,
  CheckoutHoldRequest,
  CheckoutHoldResponse,
  OrderDto,
  OrdersListResponse,
  EntitlementDto,
  EntitlementsListResponse,
  PaymentOrderRequest,
  PaymentOrderResponse,
  PaymentVerificationRequest,
  PaymentVerificationResponse,
  RefundRequest,
  RefundResponse,
} from './contracts/checkout.js';

export {
  checkoutQuoteRequestSchema,
  checkoutQuoteResponseSchema,
  checkoutHoldRequestSchema,
  checkoutHoldResponseSchema,
  orderDtoSchema,
  ordersListResponseSchema,
  entitlementDtoSchema,
  entitlementsListResponseSchema,
  paymentOrderRequestSchema,
  paymentOrderResponseSchema,
  paymentVerificationRequestSchema,
  paymentVerificationResponseSchema,
  refundRequestSchema,
  refundResponseSchema,
} from './contracts/checkout.js';

// Phase 5: Door / Scanner / Cover Wallet
export type {
  ScannerSessionCreateBody,
  ScannerSessionDto,
  ScanRequest,
  ScanResponse,
  MagicQrRequest,
  MagicQrResponse,
  OfflineManifestRequest,
  OfflineManifestResponse,
  OfflineSyncRequest,
  OfflineSyncResponse,
  DoorWalkInRequest,
  DoorDineInRequest,
  DoorSaleResponse,
  DoorSalesListResponse,
  CoverWalletIssueRequest,
  CoverWalletDebitRequest,
  CoverWalletCreditRequest,
  CoverWalletResponse,
  CoverWalletReconciliationRequest,
  CoverWalletReconciliationResponse,
  Phase5ErrorCode,
} from './contracts/phase5.js';

export {
  scannerSessionCreateBodySchema,
  scannerSessionDtoSchema,
  scanRequestSchema,
  scanResponseSchema,
  magicQrRequestSchema,
  magicQrResponseSchema,
  offlineManifestRequestSchema,
  offlineManifestResponseSchema,
  offlineSyncRequestSchema,
  offlineSyncResponseSchema,
  doorWalkInRequestSchema,
  doorDineInRequestSchema,
  doorSaleResponseSchema,
  doorSalesListResponseSchema,
  coverWalletIssueRequestSchema,
  coverWalletDebitRequestSchema,
  coverWalletCreditRequestSchema,
  coverWalletResponseSchema,
  coverWalletReconciliationRequestSchema,
  coverWalletReconciliationResponseSchema,
  phase5ErrorCodeSchema,
} from './contracts/phase5.js';