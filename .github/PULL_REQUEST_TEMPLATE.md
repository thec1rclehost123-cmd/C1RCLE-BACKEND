<!--
  This exact filename is the one GitHub auto-loads. V1 named it
  PULL_REQUEST_TEMPLATE_Checklist.md, so it never loaded on a single PR.
-->

## What changed

<!-- One paragraph. What behaviour is different after this merges? -->

## Why

<!-- Link the roadmap phase, issue, or spec. "Because it was broken" is fine if you say how. -->

## Risk

- [ ] Touches authentication, RBAC, or session handling
- [ ] Changes a `packages/contracts` schema (frontend must ship in step — see the contract-parity gate)
- [ ] Changes the `Dockerfile`, `render.yaml`, or an environment variable
- [ ] Changes a Firestore collection shape or a repository adapter
- [ ] None of the above

## Verification

<!-- What did you actually run? Paste the decisive output line, not a screenshot of green. -->

```
pnpm check
```

## Deployment note

`main` auto-deploys to https://circle-v2-backend.onrender.com. CI verifies the
deploy after the fact and rolls it back if the smoke tests fail. If this PR
needs a new environment variable, **add it in the Render dashboard before
merging** — a missing required variable fails the gateway at cold start rather
than degrading quietly.

---

<sub>CI runs format, lint, typecheck, architecture boundaries, tests + coverage
ratchet, build, Docker build + Trivy scan, and container boot. `CI OK` is the
one required check; it aggregates all of them.</sub>
