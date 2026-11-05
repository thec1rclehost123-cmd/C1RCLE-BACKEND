# Pass 6 email design and visual acceptance checkpoint

**Status: FOUNDER VISUAL REVIEW PENDING**
Candidate: backend `codex/pass6-transactional-email-20261105` at `9228644b398456aa83bee98e6583097070056ce7`
Rendering: synthetic data through the actual `createTransactionalEmailConsumer` and local capture sender. No provider send occurred.

This is a review checkpoint, not visual approval. The HTML files preserve actual output captured from each consumer invocation, including the current shared shell and template content. They have not been independently redesigned. No browser screenshots or mobile layout claims are made here. The browser environment disallowed opening `file://` HTML and expressly prohibited alternate rendering routes, so open these HTML artifacts externally to capture desktop and narrow/mobile screenshots.

## Founder review set

The index contains all 38 currently implemented V1 transactional email outcomes/variants from the consumer paths covered here, including the requested minimum set. “Template” identifies the implementation template where capture metadata was emitted; distinct outcomes may intentionally share a template.

| Review item | HTML artifact | Text alternative | Current template | Review |
| --- | --- | --- | --- | --- |
| [Event cancelled](./previews/event-cancelled.html) | [text](./previews/event-cancelled.txt) | `event_cancelled` | Pending |
| [Event cover redeemed](./previews/event-cover-redeemed.html) | [text](./previews/event-cover-redeemed.txt) | `event_cover_status` | Pending |
| [Event cover refunded](./previews/event-cover-refunded.html) | [text](./previews/event-cover-refunded.txt) | `event_cover_status` | Pending |
| [Event cover reversed](./previews/event-cover-reversed.html) | [text](./previews/event-cover-reversed.txt) | `event_cover_status` | Pending |
| [Material event change](./previews/event-material-change.html) | [text](./previews/event-material-change.txt) | `event_material_change` | Pending |
| [Event postponed](./previews/event-postponed.html) | [text](./previews/event-postponed.txt) | `event_material_change` | Pending |
| [Event rescheduled](./previews/event-rescheduled.html) | [text](./previews/event-rescheduled.txt) | `event_material_change` | Pending |
| [KYC application submitted](./previews/kyc-application-submitted.html) | [text](./previews/kyc-application-submitted.txt) | `partner_onboarding_submitted` | Pending |
| [KYC approved](./previews/kyc-approved.html) | [text](./previews/kyc-approved.txt) | `partner_onboarding_approved` | Pending |
| [KYC changes requested](./previews/kyc-changes-requested.html) | [text](./previews/kyc-changes-requested.txt) | `partner_onboarding_changes_requested` | Pending |
| [KYC rejected](./previews/kyc-rejected.html) | [text](./previews/kyc-rejected.txt) | `partner_onboarding_rejected` | Pending |
| [Payment support required](./previews/payment-support-required.html) | [text](./previews/payment-support-required.txt) | `payment_support_required` | Pending |
| [Payout failed](./previews/payout-failed.html) | [text](./previews/payout-failed.txt) | `payout_status` | Pending |
| [Payout completed](./previews/payout-paid.html) | [text](./previews/payout-paid.txt) | `payout_status` | Pending |
| [Payout processing](./previews/payout-processing.html) | [text](./previews/payout-processing.txt) | `payout_status` | Pending |
| [Payout requested](./previews/payout-requested.html) | [text](./previews/payout-requested.txt) | `payout_status` | Pending |
| [Promoter assignment accepted](./previews/promoter-assignment-accepted.html) | [text](./previews/promoter-assignment-accepted.txt) | `promoter_assignment_status` | Pending |
| [Promoter assignment declined](./previews/promoter-assignment-declined.html) | [text](./previews/promoter-assignment-declined.txt) | `promoter_assignment_status` | Pending |
| [Promoter assignment expired](./previews/promoter-assignment-expired.html) | [text](./previews/promoter-assignment-expired.txt) | `promoter_assignment_expired` | Pending |
| [Promoter assignment invited](./previews/promoter-assignment-invited.html) | [text](./previews/promoter-assignment-invited.txt) | `promoter_assignment_status` | Pending |
| [Promoter assignment revoked](./previews/promoter-assignment-revoked.html) | [text](./previews/promoter-assignment-revoked.txt) | `promoter_assignment_status` | Pending |
| [Promoter assignments suspended](./previews/promoter-assignments-suspended.html) | [text](./previews/promoter-assignments-suspended.txt) | `promoter_suspended` | Pending |
| [Purchase confirmation / receipt](./previews/purchase-confirmation.html) | [text](./previews/purchase-confirmation.txt) | `booking_receipt` | Pending |
| [Refund completed](./previews/refund-completed.html) | [text](./previews/refund-completed.txt) | `refund_completed` | Pending |
| [Refund declined / rejected](./previews/refund-declined.html) | [text](./previews/refund-declined.txt) | `refund_not_completed` | Pending |
| [Refund review requested](./previews/refund-review-requested.html) | [text](./previews/refund-review-requested.txt) | `refund_review_requested` | Pending |
| [RSVP confirmation](./previews/rsvp-confirmation.html) | [text](./previews/rsvp-confirmation.txt) | `rsvp_confirmation` | Pending |
| [Ticket add-on redeemed](./previews/ticket-addon-redeemed.html) | [text](./previews/ticket-addon-redeemed.txt) | `ticket_addon_redeemed` | Pending |
| [Ticket assignment invitation](./previews/ticket-assignment-invitation.html) | [text](./previews/ticket-assignment-invitation.txt) | `ticket_transfer_invitation` | Pending |
| [Ticket issued to current holder](./previews/ticket-issued-to-holder.html) | [text](./previews/ticket-issued-to-holder.txt) | `ticket_issued_to_holder` | Pending |
| [Ticket upgrade confirmed](./previews/ticket-upgrade-confirmed.html) | [text](./previews/ticket-upgrade-confirmed.txt) | `ticket_upgrade_confirmed` | Pending |
| [Transfer accepted — former holder](./previews/transfer-accepted-former-holder.html) | [text](./previews/transfer-accepted-former-holder.txt) | `See HTML/source branch` | Pending |
| [Transfer accepted — new holder](./previews/transfer-accepted-new-holder.html) | [text](./previews/transfer-accepted-new-holder.txt) | `See HTML/source branch` | Pending |
| [Transfer invitation expired](./previews/transfer-expired.html) | [text](./previews/transfer-expired.txt) | `ticket_transfer_expired` | Pending |
| [Transfer invitation resent](./previews/transfer-invitation-resent.html) | [text](./previews/transfer-invitation-resent.txt) | `ticket_transfer_invitation` | Pending |
| [Transfer invitation](./previews/transfer-invitation.html) | [text](./previews/transfer-invitation.txt) | `ticket_transfer_invitation` | Pending |
| [Waitlist offer expired](./previews/waitlist-expired.html) | [text](./previews/waitlist-expired.txt) | `waitlist_offer_expired` | Pending |
| [Waitlist offer](./previews/waitlist-offer.html) | [text](./previews/waitlist-offer.txt) | `waitlist_offer` | Pending |

The assignment invitation, transfer invitation, and transfer resend use the same pending-transfer invitation rendering (`ticket_transfer_invitation`). They are separately named to make the trigger variants reviewable. No acceptance confirmation is sent for assignment acceptance, as previously decided. The three transfer-accepted/expired messages use the established transfer-resolution paths.

## Synthetic fixture notes

- Event: `Night Market 2026` / `Night Market: After Dark`, with postponed and rescheduled examples.
- Ticket: two `Front Row` tickets; order reference `C1-VIS-2048`; synthetic holder identities.
- KYC: fictional venue application and a synthetic changes-requested note.
- Refund: synthetic INR 1,250.00 final outcome; receipt total uses synthetic INR 1,390.00.
- Email addresses use the reserved `.example.test` domain. No Guest, Partner, or business records were read for these previews.
- The capture path records actual consumer-produced HTML and text; it does not call Resend.
- Provider-failed refund is intentionally excluded because founder policy sends only completed and declined final outcomes. Frozen/future payout states that do not emit messages are likewise not represented.

## Capture and feedback requested

Please capture each HTML artifact at desktop width and a narrow phone width, preserving the complete message. Attach the screenshots here and include any design changes you want. Review the direction against C1RCLE's black/near-black foundation, restrained orange accent, typography, hierarchy, spacing, minimal borders, mobile readability, immediately scannable event/ticket facts, one primary CTA, and receipt-like financial layout. These are review criteria only; no visual decision is presumed.

**Checkpoint exit:** Founder approves the rendered designs or explicitly waives visual approval. Until then, Pass 6 remains open and no final Pass 6 acceptance verdict is issued.
