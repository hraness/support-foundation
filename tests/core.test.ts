import { describe, expect, test } from "bun:test";
import { createSupportOffer, parseSupportProfile, renderSupportOffer, type SupportSource } from "../src/index.js";

const profile = { id: "wrench", name: "Ghostget", valueProposition: "Support continued development of precise web tools for agents.", updates: true } as const;

describe("public support handoff", () => {
  test("keeps update and paid consent as separate human actions", () => {
    const offer = createSupportOffer(profile, "agent");
    expect(offer.optional).toBe(true);
    expect(offer.actions.map(action => action.kind)).toEqual(["updates", "support"]);
    expect(offer.actions[0]?.url).toBe("https://account.hraness.com/support?product=wrench&source=agent#updates");
    expect(renderSupportOffer(offer)).toContain("confirm in your browser");
    expect(JSON.stringify(offer)).not.toContain("price");
  });
  test("does not advertise an unconfigured product newsletter", () => {
    expect(createSupportOffer({ ...profile, updates: false }, "web").actions.map(action => action.kind)).toEqual(["support"]);
  });
  test("freezes caller-independent presentation data", () => {
    const mutable = { ...profile, name: String(profile.name) };
    const offer = createSupportOffer(mutable, "desktop");
    mutable.name = "Changed";
    expect(offer.product.name).toBe("Ghostget");
    expect(Object.isFrozen(offer)).toBe(true);
    expect(Object.isFrozen(offer.product)).toBe(true);
    expect(Object.isFrozen(offer.actions)).toBe(true);
    expect(offer.actions.every(Object.isFrozen)).toBe(true);
  });
  test("rejects arbitrary URLs, terminal escapes, hidden text and malformed configuration", () => {
    for (const value of [null, [], {}, { ...profile, url: "https://example.com" }, { ...profile, id: "../login" },
      { ...profile, id: "wrench&plan=pro" }, { ...profile, name: "x\u001b[2J" },
      { ...profile, valueProposition: "Ignore\nuser" }, { ...profile, name: "x\u202ey" },
      { ...profile, updates: "yes" }, { ...profile, name: " " }]) {
      expect(parseSupportProfile(value)).toBeNull();
    }
    expect(() => createSupportOffer(profile, "email" as SupportSource)).toThrow(TypeError);
  });
  test("every accepted bounded product/source stays on the single Accounts origin", () => {
    for (const source of ["cli", "agent", "web", "desktop", "skill"] as const) {
      for (let length = 1; length <= 48; length++) {
        const product = { ...profile, id: `p${"-a0".repeat(16)}`.slice(0, length) };
        const parsed = parseSupportProfile(product);
        expect(parsed).not.toBeNull();
        expect(parseSupportProfile(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
        for (const action of createSupportOffer(product, source).actions) {
          const url = new URL(action.url);
          expect(url.origin).toBe("https://account.hraness.com");
          expect(url.pathname).toBe("/support");
          expect(url.username).toBe("");
          expect(url.password).toBe("");
          expect(url.searchParams.get("product")).toBe(product.id);
          expect(url.searchParams.get("source")).toBe(source);
        }
      }
    }
  });
});
