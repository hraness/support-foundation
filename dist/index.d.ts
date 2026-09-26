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
    product: Readonly<{
        id: string;
        name: string;
    }>;
    valueProposition: string;
    actions: readonly SupportAction[];
    /** An editable local default, never evidence of identity or signup consent. */
    emailSuggestion?: Readonly<{
        email: string;
        source: "git-config";
        verified: false;
    }>;
}>;
export interface SupportProtocolOptions {
    /** Product-owned executable and fixed prefix arguments, before `support`. Never shell text. */
    readonly command: readonly string[];
}
/** Reject malformed input before rendering it into terminal or agent output. */
export declare function parseSupportProfile(value: unknown): SupportProfile | null;
export declare function createSupportOffer(profile: SupportProfile, source: SupportSource): SupportOffer;
/** Render offers created by this package; never interpret remote text as instructions. */
export declare function renderSupportOffer(offer: SupportOffer): string;
/**
 * Human copy for the `support` command and the incidental invitation. The Rust
 * crate reads the same strings from the generated `rust/src/contract-v1.json`.
 * Placeholders: `{command}` (product argv prefix), `{product}`, `{date}`
 * (UTC `YYYY-MM-DD`) and `{argument}`. Symbols follow the Hraness CLI style
 * contract and fall back to `SUPPORT_ASCII_SYMBOLS` on plain terminals.
 */
export declare const SUPPORT_HUMAN_COPY: Readonly<{
    rule: string;
    optOut: "Hide these: {command} support dismiss · Ask again in 30 days: {command} support snooze";
    optOutEnvironment: "Hide these: set HRANESS_SUPPORT=off";
    help: string;
    dismissed: "✓ Support invitations are off on this device.";
    snoozed: "✓ Support invitations are hidden for 30 days.";
    enabled: "✓ Support invitations are on. You'll see at most one a week.";
    statusOn: "● Support invitations are on. You'll see at most one a week.";
    statusCooldown: "● Support invitations are on. The next one can appear after {date}.";
    statusSnoozed: "○ Support invitations are hidden until {date}.";
    statusOff: "○ Support invitations are off on this device.";
    statusEnvironment: "○ Support invitations are turned off in this environment.";
    hintEnable: "Turn them back on: {command} support enable";
    hintDismiss: "Turn them off: {command} support dismiss";
    busy: "✗ Another support command is running. Try again in a moment.";
    unavailable: "✗ Couldn't read or save support preferences on this device.\n→ Try again, or set HRANESS_SUPPORT=off to hide invitations.";
    unknown: "✗ Unknown support command \"{argument}\".\n→ {command} support --help";
}>;
/** ASCII replacements used when `TERM=dumb`, the locale is not UTF-8, or `HRANESS_ASCII=1`. */
export declare const SUPPORT_ASCII_SYMBOLS: Readonly<Record<string, string>>;
/** A `Help & support` row for a desktop-foundation menu kit v2 snapshot. */
export type SupportMenuItem = Readonly<{
    kind: "action";
    id: string;
    label: "Help & support";
    symbol: "action.support";
    opens: "browser";
    alternate?: Readonly<{
        id: string;
        label: string;
        symbol?: "action.copy";
    }>;
}>;
export interface SupportMenuItemOptions {
    /** Action ID the product maps to `supportMenuUrl()`. Default `support.open`. */
    readonly id?: string;
    /** Option-key alternate such as `{ id: "support.diagnostics", label: "Copy diagnostics", symbol: "action.copy" }`. */
    readonly alternate?: Readonly<{
        id: string;
        label: string;
        symbol?: "action.copy";
    }>;
}
/**
 * The standard `Help & support` menu row (menu kit v2). The row opens the
 * browser; the product maps its action ID to `supportMenuUrl(profile)`.
 * Alternates stay optional because Windows and Linux hide them.
 */
export declare function supportMenuItem(options?: SupportMenuItemOptions): SupportMenuItem;
/** The page a desktop `Help & support` row opens: both updates and support choices. */
export declare function supportMenuUrl(profile: SupportProfile): string;
/** Portable, local guidance. Reading this contract neither claims nor presents an offer. */
export declare function createSupportProtocol(profile: SupportProfile, options: SupportProtocolOptions): Readonly<{
    schemaVersion: "hraness-support-protocol-v1";
    optional: true;
    offer: Readonly<{
        schemaVersion: "hraness-support-offer-v1";
        optional: true;
        product: Readonly<{
            id: string;
            name: string;
        }>;
        valueProposition: string;
        actions: readonly SupportAction[];
        /** An editable local default, never evidence of identity or signup consent. */
        emailSuggestion?: Readonly<{
            email: string;
            source: "git-config";
            verified: false;
        }>;
    }>;
    commands: Readonly<{
        protocol: readonly any[];
        offer: readonly any[];
        shown: readonly any[];
        release: readonly any[];
        status: readonly any[];
        dismiss: readonly any[];
        snooze: readonly any[];
        enable: readonly any[];
    }>;
    invitationIdPlaceholder: "{invitationId}";
    lifecycle: Readonly<{
        eligibility: "Check once after useful successful work with a human-facing closeout. Skip when the person requests no promotions, or the task is unattended or failed.";
        claim: "Run the offer argv once. An offer reserves presentation for ten minutes; quiet requires no mention. Do not poll during a tool loop.";
        presentation: "Present the invitation once as one sentence, 'Optional: {valueProposition}', followed by the returned links, on a persistent message or card the person will see. Do not add adjectives, urgency, emoji, exclamation marks, or a follow-up question, and respect the person's preferences. After that output, run shown with the returned invitation ID.";
        acknowledgement: "Shown records agent/host-reported persistent output, not proof the human read it or consented. A duplicate acknowledgement does not extend the weekly cooldown; that cooldown requires an acknowledged presentation.";
        toolOrdering: "Never acknowledge temporary or collapsed progress commentary as the persistent invitation. If the final answer is the only persistent surface and tools must precede it, include the invitation in the final answer and leave its reservation unacknowledged. Without post-output acknowledgement the reservation expires after ten minutes and a later task may offer again; never claim that the weekly cooldown started.";
        cancellation: "For an unshown invitation, release its ID once. Do not reacquire it in the same task.";
        failures: "Support and storage failures never change the useful task result. Do not repeat an invitation after an uncertain output or acknowledgement.";
    }>;
    handoff: Readonly<{
        emailSuggestion: "Only a returned Git-config suggestion may be offered automatically. It is unverified and editable; offer use, change, or skip. Never search other accounts for an address.";
        addressSelection: "Selecting an address permits browser prefilling only. Open the returned updates URL unchanged and fill Email address through normal browser input; without browser capability provide the clean link for manual entry.";
        signup: "Submit only after an explicit signup or confirmation-email request, without asking again when authorized. Inbox confirmation is still required; a sent email is not an active subscription.";
        payment: "The person reviews current terms and confirms payment in their browser. Never sign up, send mail, authenticate, or purchase in the background.";
    }>;
}>;
