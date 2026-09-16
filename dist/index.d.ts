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
        presentation: "Show one brief optional invitation with the returned value proposition and links on a persistent human-facing message or card, respecting the person's preferences. After that output, run shown with the returned invitation ID.";
        acknowledgement: "Shown records agent/host-reported persistent output, not proof the human read it or consented. A duplicate acknowledgement does not extend the weekly cooldown; that cooldown requires an acknowledged presentation.";
        toolOrdering: "Never acknowledge temporary or collapsed progress commentary as the persistent invitation. If the final answer is the only persistent surface and tools must precede it, include the invitation in the final answer and leave its reservation unacknowledged. Without post-output acknowledgement the reservation expires after ten minutes and a later task may offer again; never invent a weekly receipt.";
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
