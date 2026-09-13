// Vendored from dsh-oc-tui, MIT.
export function runeWidth(ch: string): number;
export function graphemes(str: string): string[];
export function displayWidth(str: string): number;
export function stripAnsi(str: unknown): string;
export function truncateWidth(str: string, width: number): string;
export function fitWidth(str: string, width: number, fill?: string): string;
export function wrapText(str: string, width: number): string[];
export function roughTokens(text: string): number;
export function formatTokens(n: number): string;
export function jsonPreview(raw: any): string;
export function toolSummary(name: string, args: any): string;
export function contentText(blocks: any[], opts?: any): string;
export function formatError(error: any): string;
