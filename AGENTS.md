# Support foundation

- Keep this package presentation-only and independent from authentication,
  provider SDKs, product code and service credentials. Accounts is authoritative
  for products, prices, consent and billing.
- Preserve root portability and opt-in Node filesystem effects. Ordinary product
  outputs and exit codes must remain unaffected by incidental invitations.
- Keep invitations optional, respect persistent dismissal and user preferences,
  and never create or confirm purchases from an offer command.
- Parse foreign state and profiles; cover URL, transition and concurrency
  invariants with meaningful tests. No test may use actual user preference state.
- Run `bun run check` before delivery. Build `dist` through the script and retain
  it for immutable Git installs. Consumers pin reviewed tags or full commits;
  never use sibling source paths in their committed manifests.
- Keep agents on disjoint files and preserve others' edits. One integrator owns
  manifests, lockfiles, generated artifacts and the final gate.
- Deliver subsequent changes through a current-head PR with passing Required
  checks and resolved reviews. Never force-push or bypass provider controls.
