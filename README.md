# Hraness support foundation

`@hraness/support-foundation` gives products a shared way to offer free product
updates and optional paid support. A portable offer links to a human Accounts
page; a Node adapter controls terminal and agent invitations with one local
cooldown and a persistent opt-out across participating tools.

The package never opens a browser, authenticates, sends email, or creates a
payment. Accounts owns available products, mailing consent, prices, recurring
terms and checkout. Stripe Link can accelerate the person's checkout when it
is enabled and eligible there.

## Create an offer

Install an immutable release of this repository in the product that owns the
integration. The root entry has no runtime dependencies or filesystem access.

```ts
import { createSupportOffer } from "@hraness/support-foundation";

const offer = createSupportOffer({
  id: "wrench",
  name: "Ghostget",
  valueProposition: "Support ongoing development of precise web tools for agents.",
  updates: true,
}, "web");

offer.actions;
// Separate free-updates and optional-paid-support links to Accounts.
```

Use the exact public product ID accepted by Accounts. Set `updates: true` only
when Accounts has an enabled public list for the product. Profile parsing
rejects malformed data and terminal control characters; accepting a profile
does not register it with Accounts. Render labels as text in web and native UI.

## Connect a CLI

Import `runSupportCommand` and `maybeShowSupportInvitation` from
`@hraness/support-foundation/node`. Route arguments following the product's
`support` command to `runSupportCommand(profile, args)`, then write its
`stdout`, `stderr`, and `exitCode` through the product's normal output adapter.
Pass `{ command: ["ghostget"] }` (or the product's executable and fixed prefix
arguments) to both adapters. These are argv elements, never shell text. The
Accounts product ID cannot identify an executable: Ghostget uses `wrench` there.

| Arguments after `support` | Behavior |
| --- | --- |
| None, or `--json` | Show an explicitly requested offer without checking or changing cadence |
| `protocol --json` | Return the portable lifecycle contract without state, Git, or network effects |
| `offer --json` | Reserve a due agent invitation, or return `kind: "quiet"` |
| `shown <id>` | Record agent/host-reported output after presentation; an identical retry never extends cooldown |
| `release <id>` | Cancel only that exact unpresented reservation |
| `dismiss` | Stop incidental invitations across participating tools on this device |
| `snooze` | Pause invitations for 30 days |
| `enable` | Re-enable invitations |
| `status --json` | Read the local invitation preference |

Call `maybeShowSupportInvitation(profile, { command: ["ghostget"], usefulResult:
true })` only after a command has completed useful work successfully. Unknown
callers, including PTYs and piped/JSON commands, receive a compact versioned
discovery notice on stderr. Stdout stays unchanged. A notice contains the
protocol command, does not discover email or reserve an invitation, and never
consumes the weekly presentation window. Its shared attempt throttle is ten
minutes. Root help and public agent documentation should also expose the
protocol command so discovery works without an installed product skill.

Set `audience: "human"` or `HRANESS_SUPPORT_AUDIENCE=human` for a direct human
invitation on interactive stderr. `agent` selects discovery, and `off` suppresses
incidental output and skill offer claims. Unknown role values fail quiet. The
explicit host option overrides the audience environment variable; CI and
`HRANESS_SUPPORT=off` always suppress incidental work. Explicit support and
protocol requests remain available. A TTY alone never establishes a human.
The integrating product must exclude help, version, errors, probes, quiet
modes, embedded/SDK execution, nested tool calls, and unattended tasks.

Ordinary commands make no support network requests. State failures suppress
incidental invitations without changing the command result. Explicit support
links remain available.

### Convenient email suggestions

When a Node offer includes product updates, the adapter can suggest the effective
`git config --get user.email` from the current directory. Discovery happens only
for an explicit offer or a due invitation, with a bounded local Git command.
Missing Git, an unset or invalid email, and no-reply addresses simply leave the
offer without a suggestion. Set `HRANESS_SUPPORT_EMAIL=off` or pass
`gitEmail: false` to disable discovery; `cwd` selects the Git context.

An available suggestion adds this optional field to the offer:

```json
{"emailSuggestion":{"email":"reader@example.com","source":"git-config","verified":false}}
```

Treat it as an editable convenience, not a verified account or consent. Offer
use/change/skip. After the person selects an address, an agent with browser
capabilities can open the returned clean updates link and fill its **Email
address** field. If browser control is unavailable, give the link for manual
entry. Submit only when the person has authorized signup or sending its
confirmation; do not ask again when that authorization is already clear. The
confirmation email still verifies the address before subscription.

The address appears in that local offer output, which an agent host may include
in its conversation. It is never added to links, preference state, telemetry or
network requests by this package. The browser-safe root entry does not discover
an email or read Git configuration.

## Agent behavior

The agent-facing command returns a dedicated, versioned result. Integrations
must preserve the existing JSON schema of ordinary commands. An agent can read
`support protocol --json` without a skill. The portable
`createSupportProtocol(profile, { command: ["ghostget"] })` export supplies the
same versioned data, including explicit command arrays, decision guidance,
value proposition, clean links, and signup/payment handoff. Replace only its
documented `{invitationId}` placeholder with a returned ID; never execute an
argv array as shell text.

Check for an offer once after completing useful work. Surface one brief optional
invitation in a persistent human-facing message or card, then acknowledge with
`shown <id>`. Temporary or collapsed progress commentary does not qualify. If
the final answer is the only persistent surface and tools must precede it, put
the invitation in that answer and leave its reservation unacknowledged. The
reservation expires after ten minutes, so a later task may offer again; no
weekly receipt is established in that fallback. Release a canceled, unshown
invitation once; do not reacquire it in the same task.

This is guidance for cooperating product skills. A tool response cannot force
an external agent to advertise or override its user. Respect a user's request
to stop, never make task completion conditional on subscribing, and leave
payment confirmation to the person. See [agent integration](docs/agents.md).

## Cadence and privacy

The default is one invitation after the first eligible useful result, then
at most once every seven days after an acknowledged presentation across
participating tools on the same device. Hosts unable to acknowledge persistent
output use the ten-minute reservation fallback described above.
A short reservation prevents concurrent tools from making duplicate offers.
Dismissal is persistent; later means a 30-day snooze. Explicit support requests
remain available even after dismissal.

The Node adapter stores only invitation preferences, timestamps and opaque
invitation IDs under `$XDG_STATE_HOME/hraness/support`, or
`~/.local/state/hraness/support`. Set `HRANESS_SUPPORT=off` to suppress incidental
offers. There is no background telemetry, account authentication, cross-device
tracking or payment information. Browser and mobile preferences are a separate
integration; local CLI state does not magically synchronize with them.

The existing strict `state.json` v1 schema remains unchanged. Separate bounded
`discovery.json` and `presentation.json` sidecars share its nonblocking lock, so
older clients keep using the same dismissal, snooze, reservation, and cooldown.
Older clients do not implement discovery or idempotent acknowledgment and must
be upgraded for the new presentation-order contract. A retry is valid only when
its requested ID matches the receipt and the receipt timestamp matches committed
state; stale IDs cannot affect a newer reservation. Malformed or unavailable state is preserved and suppresses
incidental work, never reset silently.

Presentation means the host or agent reports output, not that a person read it
or consented. Human-mode output is revalidated under the preference lock after
email discovery, then written before its receipt is committed. Output waits are
capped at 500 ms; asynchronous errors and rejected sinks earn no weekly
cooldown. An unresolved sink admits no further write until it settles. A crash
or storage failure after output can leave only the ten-minute reservation, so
a later task may repeat an invitation. No cross-process human-display proof or
exactly-once guarantee is claimed.

## Other media

Use the same root offer for a website footer or a desktop menu action. The
product owns its presentation and browser-opening action. Keep web links
visible without automatic modals; use stable desktop menu items. Newsletter
signup and payment remain independent choices. Applications distributed
through app stores must use their applicable purchasing rules.

Future one-time payments need a separate product-owned payment flow. This
release offers the existing suite membership; it does not advertise an
unimplemented tip checkout or grant paid entitlements.

## Verify

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

The gate checks TypeScript, URL and state invariants, concurrent invitations,
preferences and dedicated command behavior, then verifies the built package
under Node and its browser-safe root. These local tests make no provider calls
and do not prove that a deployed Accounts route or Stripe configuration is live.
