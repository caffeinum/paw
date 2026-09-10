export function quoteText(selection: string | null | undefined): string;
export function composeQuote(draft: string | null | undefined, selection: string | null | undefined): string;
export function quotable(input: { text?: string | null; insideMessage: boolean; minChars?: number }): boolean;
