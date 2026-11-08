# Tax rules

Tax rates are **data with an approval trail**, not constants in the code. Whether GST applies to a
ticket, and whether TDS under s.194-O or GST TCS under s.52 applies to this business model, are
legal and accounting conclusions. Until a chartered accountant has confirmed them in writing, the
system assumes none of them.

## Default: nothing applies
There are no rules out of the box. Looking one up (`taxRules.activeRule(kind)`) returns `null`,
meaning "apply no tax of this kind". **Nothing in pricing or settlement reads these rules yet**, so
adding this changes no amount anywhere. It is the mechanism the current hardcoded figures can later
be moved onto.

## Kinds
`ticket_gst`, `convenience_fee_gst`, `tds_194o`, `gst_tcs_s52`. Each rule also records its **basis**
(what the rate is applied to) so that is never guessed later.

## Lifecycle
1. **Draft** (finance / admin / super): kind, rate in basis points (1800 = 18%), basis, effective
   dates. A draft has no effect.
2. **Enable** (a *different* person): needs a reference to the written advice (`approvalRef`, e.g. a
   CA letter and date). Refused if the enabler is the author, if the reference is missing, or if
   another enabled rule of the same kind covers any of the same days.
3. **Retire**: an enabled rule is never edited. A change is a new rule plus a retirement, so the
   rate that applied on any past date can be reconstructed.

`ops` and `support` cannot touch tax rules. Every create / enable / retire is written to the admin
audit log with who, when and the advice relied on. Dates are India dates (IST).

## Not built yet
Wiring pricing and settlement to read rules, an admin screen, and the frontend mirror of the
`TAX_RULE_UPDATE` audit action.

## API (platform admins; tax changes: super / admin / finance only)
| | |
|---|---|
| `GET /admin/tax-rules[?kind=]` | list rules |
| `POST /admin/tax-rules` | draft a rule (`201`) |
| `POST /admin/tax-rules/:ruleId/enable` | body `{ approvalRef }`; a different admin than the author |
| `POST /admin/tax-rules/:ruleId/retire` | body `{ reason }` |

Writes need an `Idempotency-Key`; a replay returns the original result.
