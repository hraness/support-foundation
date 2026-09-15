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

| Arguments after `support` | Behavior |
| --- | --- |
| None, or `--json` | Show an explicitly requested offer without checking or changing cadence |
| `offer --json` | Reserve a due agent invitation, or return `kind: "quiet"` |
| `shown <id>` | Record presentation of that reserved invitation |
| `dismiss` | Stop incidental invitations across participating tools on this device |
| `snooze` | Pause invitations for 30 days |
| `enable` | Re-enable invitations |
| `status --json` | Read the local invitation preference |

Call `maybeShowSupportInvitation(profile, { usefulResult: true })` only after
a command has completed useful work successfully. It writes to interactive
stderr. The integrating product must exclude help, version, errors, probes,
JSON/raw output, quiet modes, nested tool calls and unattended tasks.

Ordinary commands make no support network requests. State failures suppress
incidental invitations without changing the command result. Explicit support
links remain available.

## Agent behavior

The agent-facing command returns a dedicated, versioned result. Integrations
must preserve the existing JSON schema of ordinary commands. Product skills
can check for an offer once after completing a useful task, include one short
optional invitation, and acknowledge presentation using its opaque ID.

This is guidance for cooperating product skills. A tool response cannot force
an external agent to advertise or override its user. Respect a user's request
to stop, never make task completion conditional on subscribing, and leave
payment confirmation to the person. See [agent integration](docs/agents.md).

## Cadence and privacy

The default is one invitation after the first eligible useful result, then
at most once every seven days across participating tools on the same device.
A short reservation prevents concurrent tools from making duplicate offers.
Dismissal is persistent; later means a 30-day snooze. Explicit support requests
remain available even after dismissal.

The Node adapter stores only invitation preferences, timestamps and an opaque
reservation under `$XDG_STATE_HOME/hraness/support`, or
`~/.local/state/hraness/support`. Set `HRANESS_SUPPORT=off` to suppress incidental
offers. There is no background telemetry, account discovery, cross-device
tracking or payment information. Browser and mobile preferences are a separate
integration; local CLI state does not magically synchronize with them.

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
