# Rust binding

The `hraness-support-foundation` Cargo crate belongs to this repository and
uses the same optional invitation protocol and suite-wide local state as the
JavaScript adapter. Products supply only their profile, command argv and useful
success classification. No JavaScript runtime is required by an installed Rust
consumer. The binding never opens a browser, makes a network request, signs up
an address or confirms a payment.

`scripts/rust-contract.ts` derives the committed Rust protocol text, schemas
and cadence constants from the published JavaScript implementation. The release
gate rejects drift and exercises both runtimes against the same temporary state
directory, including concurrent claims and cross-runtime acknowledgements.

The shared `state.lock` is a nonblocking create-new claim. Neither runtime
steals stale locks. State and receipts remain bounded JSON, with atomic private
temporary writes and the same receipt-before-state acknowledgement ordering.
Support errors never change the useful product result.

## Product adapter

Pin `hraness-support-foundation` from the reviewed repository release using a
full Git revision. The crate is in `rust/`; Cargo locates it from the workspace.
Use `run_support_command(&profile, &args, &options)` for the explicit `support`
subcommand and forward its `stdout`, `stderr` and `exit_code`. Set
`options.command` to the executable and fixed argv prefix, not shell text.

After a classified useful successful CLI operation, call
`maybe_show_support_invitation(&profile, true, &options)`. Skip help, version,
probes, quiet modes, embedded execution and unattended work. This hook writes
only stderr and returns a best-effort output result. Do not propagate it as the
product's exit status. The audience follows the same rule as the Node adapter:
explicit option or environment, then agent markers, then human at an
interactive stderr, else quiet. `Options::stderr_is_terminal` overrides the
terminal check for explicit commands. Explicit human mode additionally requires
interactive stderr. The same environment controls,
state path and command syntax documented in the main README apply.

Only an explicit offer or eligible human/agent offer with `updates: true` can
read the effective local Git email. The direct argv command is capped at 500 ms
and 1024 bytes per output stream; timeout kills and reaps its child. Suggestions
remain unverified, editable, absent from links and state, and opt-out capable.
Products without a mailing list set `updates: false` and never run this lookup.

## Platform and output boundaries

Linux, macOS and Windows run the same interop gate. Unix state reads use
`O_NOFOLLOW | O_NONBLOCK`; Windows opens the reparse point itself and rejects
reparse metadata. New Unix files use mode 0600 and directories 0700. Windows
inherits the owning directory's ACL, matching the platform's normal Node file
creation semantics. No lock is stolen, including one left by a crashed process.

A Rust output worker bounds the caller's wait to 500 ms. A blocked underlying
writer may settle later; clones share one pending-write guard until then. Late
or failed output never starts the weekly cooldown. The process does not wait for
that worker during exit. This is accepted-output accounting, not display or
consent proof; it has the same uncertain-output reservation fallback as Node.
Custom `Output` sinks must return success only after accepting the full text.

The test-only `interop` example exchanges JSON with the Bun suite. It is never
installed as a consumer executable. Release checks regenerate neither contract
nor state: they verify the committed contract against JavaScript, then exercise
both runtimes against disposable test-owned directories.
