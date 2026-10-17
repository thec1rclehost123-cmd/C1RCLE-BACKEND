# Refunds and chargebacks: decisions needed before the refund step is built

**Status:** waiting on finance (and the CA for the tax lines). **Nothing in this document is built.**
It exists because the next piece of engineering, actually sending a refund to the payment provider
and unwinding the money, cannot be written without answers to the questions below. Each has a
recommended default so the decision can be "agree" or "change it", but the recommendations are
engineering's reading of the code, not financial or legal advice.

## What exists today
- A customer's payment is split into legs at sale time: host, venue, promoter, the platform's
  commission (0% by default), and GST on the guest's fees as its own line.
- **Admin refunds stop at "approved" on purpose.** A request is raised, approved by one or more
  admins (more approvers above larger amounts), and then nothing is sent. There is no step that
  tells Razorpay to refund or that reverses the legs.
- The only automatic refund is a payment that arrives after its hold expired and the seats are
  gone: it is refunded in full, immediately, to protect the buyer. No legs exist yet in that case.
- The provider's side of every payment (captured, **its fee and the tax on it**, refunds,
  disputes) is now recorded separately and can be compared with our orders. That is a fact store;
  it moves no money and decides none of the questions below.

## Decisions

### 1. When an order that has been split is refunded, who funds it?
The host, venue and promoter shares were credited at sale time. Options:
- **A. Reverse each leg in proportion** (a 50% refund takes back 50% of each share). Fair and
  simple to explain; the partner's balance can go negative if they were already paid out.
- **B. The platform absorbs refunds** and partners keep their shares. Simplest for partners;
  costs the platform real money on every refund.
- **C. Reverse proportionally against unpaid balance only,** and the platform absorbs whatever was
  already paid out. Middle road.

*Suggested default:* **A**, with a rule for the negative balance (see 2). Needs finance's approval
and a line in the partner agreement.

### 2. What if a partner has already been paid out?
- **A. Net it against their next payouts** (a negative balance carried forward).
- **B. Ask them to return it.**
- **C. Platform absorbs it.**

*Suggested default:* **A**, with a cap and a notice to the partner. Collecting money back from a
partner is a contract question for the lawyer.

### 3. Who bears the payment provider's fee on a refunded payment?
Razorpay generally keeps its fee (and the tax on it) when a payment is refunded. That cost has to
land somewhere: the platform, or shared with the partner pro rata.

*Suggested default:* **the platform**, as a cost of doing business, unless the partner agreement
says otherwise.

### 4. Which tickets can be refunded?
- Already **scanned/redeemed** tickets: refundable never, only with a reason, or only with two
  approvals? (The system already counts redeemed tickets and requires more approvals; the rule is
  not fixed.)
- Refund windows (e.g. up to N hours before the event), event cancelled by the host (always full
  refund?), partial refunds (per ticket, or any amount?).

*Suggested default:* full refund if the host cancels; otherwise per ticket, never after scan,
window set per event by the host within platform limits.

### 5. Chargebacks (the buyer disputes with their bank)
- Who bears a **lost** dispute: the platform, or the partner whose event it was?
- Who bears Razorpay's **dispute fee**?
- Is a payout held while a dispute is open?

*Suggested default:* the partner bears a lost dispute for their own event (with evidence support
from the platform), the platform bears the dispute fee, and **pending payouts for that order are
held while the dispute is open**. This is the most commercially sensitive decision here.

### 6. Tax on a refund (CA)
A refund of a taxable supply normally needs a credit note and a GST adjustment, and a refund may
change TDS / GST TCS already reported. **None of this can be coded until the CA says which taxes
apply** (the tax-rule scaffold exists and has no rules enabled).

### 7. Speed and limits
Refund approval thresholds already exist (single approver below one amount, two above another).
Confirm those numbers, and confirm whether refunds are sent automatically once approved or by a
separate "send" action.

*Suggested default:* a separate explicit "send to Razorpay" action, so approval and money
movement are different steps by different people for large amounts.

## What engineering builds once these are answered
1. A "settle refund" action that sends the refund to Razorpay once, safely repeatable, and marks
   the order.
2. The reversal of legs according to decisions 1, 2 and 5, as new ledger entries (never edits).
3. Payout holds for open disputes.
4. Credit notes and tax adjustments according to decision 6.
5. Reconciliation against Razorpay's own refund and dispute records (already recorded) as the check
   that the books and the provider agree.

Please reply per number with "agree" or the change you want, and who signed off.
