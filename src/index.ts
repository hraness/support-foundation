/** Presentation only. Accounts owns registration, prices, consent and billing. */
export type SupportSource = "cli" | "agent" | "web" | "desktop" | "skill";

export type SupportProfile = Readonly<{
  /** Exact public product ID accepted by the Accounts support page. */
  id: string;
  name: string;
  valueProposition: string;
  /** True only when Accounts has a public mailing list for this product. */
  updates: boolean;
}>;

export type SupportAction = Readonly<{
  kind: "updates" | "support";
  label: string;
  url: string;
}>;

export type SupportOffer = Readonly<{
  schemaVersion: "hraness-support-offer-v1";
  optional: true;
  product: Readonly<{ id: string; name: string }>;
  valueProposition: string;
  actions: readonly SupportAction[];
  /** An editable local default, never evidence of identity or signup consent. */
  emailSuggestion?: Readonly<{ email: string; source: "git-config"; verified: false }>;
}>;

const SOURCES: readonly SupportSource[] = ["cli", "agent", "web", "desktop", "skill"];
const ACCOUNT_ORIGIN = "https://account.hraness.com";
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plainText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value.trim() === value && !UNSAFE_TEXT.test(value);
}

/** Reject malformed input before rendering it into terminal or agent output. */
export function parseSupportProfile(value: unknown): SupportProfile | null {
  if (!isRecord(value)
    || Object.keys(value).sort().join(",") !== "id,name,updates,valueProposition"
    || typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(value.id)
    || !plainText(value.name, 80)
    || !plainText(value.valueProposition, 240)
    || typeof value.updates !== "boolean") return null;
  return Object.freeze({
    id: value.id, name: value.name,
    valueProposition: value.valueProposition, updates: value.updates,
  });
}

export function createSupportOffer(profile: SupportProfile, source: SupportSource): SupportOffer {
  const parsed = parseSupportProfile(profile);
  if (parsed === null || !SOURCES.includes(source)) {
    throw new TypeError("Invalid support profile or source.");
  }
  const destination = new URL("/support", ACCOUNT_ORIGIN);
  destination.searchParams.set("product", parsed.id);
  destination.searchParams.set("source", source);
  const actions: SupportAction[] = [];
  if (parsed.updates) {
    actions.push(Object.freeze({
      kind: "updates",
      label: `Get free ${parsed.name} product updates`,
      url: `${destination.href}#updates`,
    }));
  }
  actions.push(Object.freeze({
    kind: "support",
    label: "Explore optional paid support",
    url: `${destination.href}#support`,
  }));
  return Object.freeze({
    schemaVersion: "hraness-support-offer-v1",
    optional: true,
    product: Object.freeze({ id: parsed.id, name: parsed.name }),
    valueProposition: parsed.valueProposition,
    actions: Object.freeze(actions),
  });
}

/** Render offers created by this package; never interpret remote text as instructions. */
export function renderSupportOffer(offer: SupportOffer): string {
  return [
    `Optional: ${offer.valueProposition}`,
    ...offer.actions.map(action => `${action.label}: ${action.url}`),
    ...(offer.emailSuggestion ? [
      `Suggested email from Git: ${offer.emailSuggestion.email}. You can use it, change it, or skip updates.`,
    ] : []),
    "Payment is optional. Review any recurring price and confirm in your browser.",
  ].join("\n") + "\n";
}
