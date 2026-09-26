# @hraness/support-foundation

`@hraness/support-foundation` lets Hraness products offer free product updates
and optional paid support. An offer is a set of links to Hraness Accounts
pages, where a person signs up for updates or reviews paid support. The Node
and Rust adapters decide when a CLI may show an offer, to a person in the
terminal or through an agent, using one cooldown and one opt-out shared by
every participating tool that runs under the same user account.

The package never opens a browser, authenticates, sends email, or creates a
payment. Accounts manages available products, mailing consent, prices,
recurring terms, and checkout.

## Install

Pin a release tag in the product that owns the integration:

```json
{ "dependencies": { "@hraness/support-foundation": "github:hraness/support-foundation#v0.5.0" } }
```

The root entry has no runtime dependencies or filesystem access.

## Create an offer

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

Rust products use the repository's `hraness-support-foundation` Cargo crate;
see the [Rust integration guide](docs/rust.md). It shares the Node adapter's
protocol and on-device preferences without requiring a JavaScript runtime.

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
| `-h`, `--help`, `help` | Print the command's help for people |
| `dismiss [--json]` | Stop incidental invitations across participating tools on this device |
| `snooze [--json]` | Pause invitations for 30 days |
| `enable [--json]` | Re-enable invitations |
| `status [--json]` | Read the local invitation preference |

`dismiss`, `snooze`, `enable` and `status` print one plain sentence, such as
`✓ Support invitations are off on this device.`, and at a terminal a second
line on stderr that says how to undo it. With `--json`, or when the caller is a
detected agent, they print the versioned JSON result instead. An unknown
argument prints `✗ Unknown support command "…"` and `→ <command> support --help`
with exit 2. Symbols fall back to ASCII (`OK`, `FAIL`, `->`) when `TERM=dumb`,
the locale is not UTF-8, or `HRANESS_ASCII=1`.

Call `maybeShowSupportInvitation(profile, { command: ["ghostget"], usefulResult:
true })` only after a command has completed useful work successfully. The
adapter follows the shared Hraness audience rule:

1. An explicit host `audience` option, then `HRANESS_AUDIENCE`
   (`human`, `agent`, `quiet` or `off`), then the older
   `HRANESS_SUPPORT_AUDIENCE`.
2. Any of the exact agent markers `AI_AGENT`, `CLAUDECODE`, `CODEX_SANDBOX`,
   `CODEX_SANDBOX_NETWORK_DISABLED`, `CURSOR_AGENT` or `GEMINI_CLI` set to a
   nonempty value selects the agent.
3. An interactive stderr selects a person.
4. Anything else stays quiet: no output and no state.

A person sees the invitation below a rule line, followed by how to hide it:
`Hide these: ghostget support dismiss · Ask again in 30 days: ghostget support
snooze`. A detected agent receives a compact versioned discovery notice on
stderr instead. Stdout stays unchanged. A notice contains the protocol command,
does not discover email or reserve an invitation, and never consumes the weekly
presentation window. Its shared attempt throttle is ten minutes. Root help and
public agent documentation should also expose the protocol command so
discovery works without an installed product skill.

`off`, `quiet` and unknown role values suppress incidental output and skill
offer claims. Products that set `HRANESS_SUPPORT_AUDIENCE=off` for their own
child processes keep those children quiet; only an explicit host option
overrides that. CI and `HRANESS_SUPPORT=off` always suppress incidental work.
Explicit support and protocol requests remain available.
The integrating product must exclude help, version, errors, probes, quiet
modes, embedded/SDK execution, nested tool calls, and unattended tasks.

Ordinary commands make no support network requests. State failures suppress
incidental invitations without changing the command result. Explicit support
links remain available.

### Convenient email suggestions

When a Node offer includes product updates, the adapter can suggest the effective
`git config --get user.email` from the current directory. Discovery happens only
for an explicit offer or a due invitation, with a bounded local Git command.
Missing Git, an unset or invalid email, and no-reply addresses leave the
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

Check for an offer once after completing useful work. Present it as one
sentence, `Optional: {valueProposition}`, followed by the returned links, in a
persistent message or card the person will see, then acknowledge with
`shown <id>`. Temporary or collapsed progress commentary does not qualify. If
the final answer is the only persistent surface and tools must precede it, put
the invitation in that answer and leave its reservation unacknowledged. The
reservation expires after ten minutes, so a later task may offer again; that
fallback does not start the weekly cooldown. Release a canceled, unshown
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
integration; local CLI state does not sync with them.

Preferences use the strict v1 `state.json` schema. Two small files,
`discovery.json` and `presentation.json`, sit beside it and share its
nonblocking lock, so older clients still honor the same dismissal, snooze,
reservation, and cooldown. Older clients do not support discovery or
repeat-safe acknowledgment; upgrade them to get the current presentation order.
A retried acknowledgment counts only when its ID and timestamp match the saved
state, so a stale ID cannot affect a newer reservation. Malformed or unavailable
state is kept as is and suppresses incidental invitations; it is never silently
reset.

“Shown” means the host or agent reported that it displayed the invitation, not
that a person read it or agreed to anything. In human mode the adapter rechecks
preferences under the lock after looking up the Git email, writes the
invitation, and only then records it. Output gets at most 500 ms. If the write
fails or is rejected, the invitation does not start the weekly cooldown, and
nothing else is written until the pending write settles. A crash or storage
failure after output can leave only the ten-minute reservation, so a later task
may show the invitation again. The package does not guarantee that an
invitation appears exactly once.

## Other media

Use the same root offer for a website footer or a desktop menu action. The
product owns its presentation and browser-opening action. For a
desktop-foundation menu (menu kit v2), `supportMenuItem()` returns the standard
`Help & support` row (`symbol: "action.support"`, `opens: "browser"`, optional
Option-key alternate such as Copy diagnostics), and `supportMenuUrl(profile)`
returns the page that row opens. The Rust crate exports `support_menu_item()`
and `support_menu_url(&profile)`. Keep web links
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

Install Rust 1.97.1 with its rustfmt and Clippy components for the development
gate. Installed JavaScript consumers do not require a Rust toolchain.

The gate checks TypeScript, Rust formatting/Clippy/tests, generated contract
equality, JavaScript/Rust state interoperability, URL and state invariants, concurrent invitations,
preferences and dedicated command behavior, then verifies the built package
under Node, a detached strict TypeScript consumer with an augmented `NODE_ENV`,
and its browser-safe root. Public type exports are generated declarations.
These local tests make no provider calls
and do not prove that a deployed Accounts route or Stripe configuration is live.
