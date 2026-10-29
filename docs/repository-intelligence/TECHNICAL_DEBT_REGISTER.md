# Technical Debt Register

| Debt | Origin | Affected area | Risk | Resolution | Ideal milestone |
|---|---|---|---|---|---|
| Fixture/live boundary ambiguity | M3 UI/data-source evolution | Partner and guest surfaces | False readiness | Explicit source status and integration gates | M3 exit |
| Cross-repo contract drift risk | Shared contract edits in both dirty trees | API/client layers | Runtime mismatch | Parity check in CI and staging | M3 exit |
| Incomplete runtime evidence | Safety boundary and absent live proof | Payments, email, deployment | Release uncertainty | Staged evidence matrix | M3/M4 |
| Broad dirty-tree review surface | Large simultaneous change set | All packages | Regression review cost | Partitioned diffs and independent gates | Before release |
