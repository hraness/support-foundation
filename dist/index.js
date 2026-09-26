// src/index.ts
var SOURCES = ["cli", "agent", "web", "desktop", "skill"];
var ACCOUNT_ORIGIN = "https://account.hraness.com";
var UNSAFE_TEXT = new RegExp("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]", "u");
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function plainText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !UNSAFE_TEXT.test(value);
}
function parseSupportProfile(value) {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "id,name,updates,valueProposition" || typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(value.id) || !plainText(value.name, 80) || !plainText(value.valueProposition, 240) || typeof value.updates !== "boolean")
    return null;
  return Object.freeze({
    id: value.id,
    name: value.name,
    valueProposition: value.valueProposition,
    updates: value.updates
  });
}
function createSupportOffer(profile, source) {
  const parsed = parseSupportProfile(profile);
  if (parsed === null || !SOURCES.includes(source)) {
    throw new TypeError("Invalid support profile or source.");
  }
  const destination = new URL("/support", ACCOUNT_ORIGIN);
  destination.searchParams.set("product", parsed.id);
  destination.searchParams.set("source", source);
  const actions = [];
  if (parsed.updates) {
    actions.push(Object.freeze({
      kind: "updates",
      label: `Get free ${parsed.name} product updates`,
      url: `${destination.href}#updates`
    }));
  }
  actions.push(Object.freeze({
    kind: "support",
    label: "See paid support options",
    url: `${destination.href}#support`
  }));
  return Object.freeze({
    schemaVersion: "hraness-support-offer-v1",
    optional: true,
    product: Object.freeze({ id: parsed.id, name: parsed.name }),
    valueProposition: parsed.valueProposition,
    actions: Object.freeze(actions)
  });
}
function renderSupportOffer(offer) {
  return [
    `Optional: ${offer.valueProposition}`,
    ...offer.actions.map((action) => `${action.label}: ${action.url}`),
    ...offer.emailSuggestion ? [
      `Suggested email from Git: ${offer.emailSuggestion.email}. You can use it, change it, or skip updates.`
    ] : [],
    "Payment is optional. Review any recurring price and confirm in your browser."
  ].join(`
`) + `
`;
}
var SUPPORT_HUMAN_COPY = Object.freeze({
  rule: "─".repeat(40),
  optOut: "Hide these: {command} support dismiss · Ask again in 30 days: {command} support snooze",
  optOutEnvironment: "Hide these: set HRANESS_SUPPORT=off",
  help: [
    "Usage: {command} support [command]",
    "",
    "See optional product updates and paid support for {product}.",
    "",
    "Commands",
    "  (none)      Show the links for updates and support",
    "  status      Show whether invitations are on",
    "  dismiss     Stop showing invitations on this device",
    "  snooze      Hide invitations for 30 days",
    "  enable      Show invitations again",
    "",
    "Options",
    "  --json      Print machine-readable output",
    "  -h, --help  Show this help"
  ].join(`
`),
  dismissed: "✓ Support invitations are off on this device.",
  snoozed: "✓ Support invitations are hidden for 30 days.",
  enabled: "✓ Support invitations are on. You'll see at most one a week.",
  statusOn: "● Support invitations are on. You'll see at most one a week.",
  statusCooldown: "● Support invitations are on. The next one can appear after {date}.",
  statusSnoozed: "○ Support invitations are hidden until {date}.",
  statusOff: "○ Support invitations are off on this device.",
  statusEnvironment: "○ Support invitations are turned off in this environment.",
  hintEnable: "Turn them back on: {command} support enable",
  hintDismiss: "Turn them off: {command} support dismiss",
  busy: "✗ Another support command is running. Try again in a moment.",
  unavailable: `✗ Couldn't read or save support preferences on this device.
→ Try again, or set HRANESS_SUPPORT=off to hide invitations.`,
  unknown: `✗ Unknown support command "{argument}".
→ {command} support --help`
});
var SUPPORT_ASCII_SYMBOLS = Object.freeze({
  "✓": "OK",
  "✗": "FAIL",
  "→": "->",
  "●": "*",
  "○": "o",
  "─": "-",
  "·": "-"
});
var ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function supportMenuItem(options = {}) {
  const id = options.id ?? "support.open";
  const alternate = options.alternate;
  if (!ACTION_ID.test(id) || id.startsWith("foundation.") || alternate !== undefined && (!ACTION_ID.test(alternate.id) || alternate.id === id || alternate.id.startsWith("foundation.") || !plainText(alternate.label, 48) || alternate.symbol !== undefined && alternate.symbol !== "action.copy")) {
    throw new TypeError("Invalid support menu item options.");
  }
  return Object.freeze({
    kind: "action",
    id,
    label: "Help & support",
    symbol: "action.support",
    opens: "browser",
    ...alternate === undefined ? {} : {
      alternate: Object.freeze({ id: alternate.id, label: alternate.label, ...alternate.symbol === undefined ? {} : { symbol: alternate.symbol } })
    }
  });
}
function supportMenuUrl(profile) {
  const offer = createSupportOffer(profile, "desktop");
  const url = new URL(offer.actions[0].url);
  url.hash = "";
  return url.href;
}
function createSupportProtocol(profile, options) {
  const command = options.command;
  if (!Array.isArray(command) || command.length < 1 || command.length > 8 || !Array.from(command).every((part) => plainText(part, 240))) {
    throw new TypeError("Invalid support command prefix.");
  }
  const argv = (...args) => Object.freeze([...command, "support", ...args]);
  return Object.freeze({
    schemaVersion: "hraness-support-protocol-v1",
    optional: true,
    offer: createSupportOffer(profile, "agent"),
    commands: Object.freeze({
      protocol: argv("protocol", "--json"),
      offer: argv("offer", "--json"),
      shown: argv("shown", "{invitationId}"),
      release: argv("release", "{invitationId}"),
      status: argv("status", "--json"),
      dismiss: argv("dismiss"),
      snooze: argv("snooze"),
      enable: argv("enable")
    }),
    invitationIdPlaceholder: "{invitationId}",
    lifecycle: Object.freeze({
      eligibility: "Check once after useful successful work with a human-facing closeout. Skip when the person requests no promotions, or the task is unattended or failed.",
      claim: "Run the offer argv once. An offer reserves presentation for ten minutes; quiet requires no mention. Do not poll during a tool loop.",
      presentation: "Present the invitation once as one sentence, 'Optional: {valueProposition}', followed by the returned links, on a persistent message or card the person will see. Do not add adjectives, urgency, emoji, exclamation marks, or a follow-up question, and respect the person's preferences. After that output, run shown with the returned invitation ID.",
      acknowledgement: "Shown records agent/host-reported persistent output, not proof the human read it or consented. A duplicate acknowledgement does not extend the weekly cooldown; that cooldown requires an acknowledged presentation.",
      toolOrdering: "Never acknowledge temporary or collapsed progress commentary as the persistent invitation. If the final answer is the only persistent surface and tools must precede it, include the invitation in the final answer and leave its reservation unacknowledged. Without post-output acknowledgement the reservation expires after ten minutes and a later task may offer again; never claim that the weekly cooldown started.",
      cancellation: "For an unshown invitation, release its ID once. Do not reacquire it in the same task.",
      failures: "Support and storage failures never change the useful task result. Do not repeat an invitation after an uncertain output or acknowledgement."
    }),
    handoff: Object.freeze({
      emailSuggestion: "Only a returned Git-config suggestion may be offered automatically. It is unverified and editable; offer use, change, or skip. Never search other accounts for an address.",
      addressSelection: "Selecting an address permits browser prefilling only. Open the returned updates URL unchanged and fill Email address through normal browser input; without browser capability provide the clean link for manual entry.",
      signup: "Submit only after an explicit signup or confirmation-email request, without asking again when authorized. Inbox confirmation is still required; a sent email is not an active subscription.",
      payment: "The person reviews current terms and confirms payment in their browser. Never sign up, send mail, authenticate, or purchase in the background."
    })
  });
}
export {
  supportMenuUrl,
  supportMenuItem,
  renderSupportOffer,
  parseSupportProfile,
  createSupportProtocol,
  createSupportOffer,
  SUPPORT_HUMAN_COPY,
  SUPPORT_ASCII_SYMBOLS
};
