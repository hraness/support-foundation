import { type SupportProfile } from "./index.js";
export interface SupportCommandOptions {
    /** Product-owned executable and fixed prefix arguments before `support`. */
    readonly command?: readonly string[];
    /** Explicit host role wins over HRANESS_SUPPORT_AUDIENCE; off/invalid suppress incidental work. */
    readonly audience?: SupportAudience;
    readonly stateDirectory?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** Epoch milliseconds; useful for deterministic hosts and tests. */
    readonly now?: number;
    /** Directory whose effective Git configuration supplies the optional suggestion. */
    readonly cwd?: string;
    /** Disable local Git-email suggestions without disabling support invitations. */
    readonly gitEmail?: boolean;
}
export type SupportAudience = "agent" | "human" | "off";
export interface SupportOutput {
    readonly isTTY?: boolean;
    write(text: string, callback?: (error?: Error | null) => void): unknown;
    on?(event: string, listener: (...args: any[]) => void): unknown;
    removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}
export interface SupportCommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}
export interface SupportInvitationOptions extends SupportCommandOptions {
    /** Set only for a completed, useful operation, never help, probes, or failures. */
    readonly usefulResult: boolean;
    /** Unknown callers, including PTYs, receive discovery. TTY alone never implies a human. */
    readonly stderr?: SupportOutput;
}
/** Explicit offers always work independently of local preferences; no action opens a browser or pays. */
export declare function runSupportCommand(profile: SupportProfile, args?: readonly string[], options?: SupportCommandOptions): Promise<SupportCommandResult>;
/** Best-effort post-success notice. Never call this for failed or merely diagnostic work. */
export declare function maybeShowSupportInvitation(profile: SupportProfile, options: SupportInvitationOptions): Promise<boolean>;
