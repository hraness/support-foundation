// src/index.ts
var SOURCES = ["cli", "agent", "web", "desktop", "skill"];
var ACCOUNT_ORIGIN = "https://account.hraness.com";
var UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
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
    label: "Explore optional paid support",
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
export {
  renderSupportOffer,
  parseSupportProfile,
  createSupportOffer
};
