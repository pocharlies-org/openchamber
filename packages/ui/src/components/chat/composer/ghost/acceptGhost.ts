/**
 * Puts an accepted suggestion into the composer.
 *
 * Extracted from the key handler so that `Tab` and the footer button — which
 * exists because phones have no `Tab` — cannot drift apart, and so the offset
 * can be tested. That offset is the whole contract: the suggestion is drawn as
 * a widget past the last character, never as document text, so the end of the
 * document is the only position where inserting it reproduces what the user
 * saw. Inserting at the caret would put the text somewhere else entirely
 * whenever the caret is not at the end.
 */

/** The slice of the composer editor handle this needs. */
export interface GhostInsertTarget {
    getValue: () => string;
    replaceRange: (from: number, to: number, text: string) => void;
    focus: () => void;
}

/**
 * Returns whether anything was inserted. A miss is normal: the suggestion may
 * have been cleared between the tap and this call.
 */
export function insertGhostSuggestion(
    target: GhostInsertTarget | null,
    accepted: string | null,
): boolean {
    if (!target || !accepted) return false;
    const end = target.getValue().length;
    target.replaceRange(end, end, accepted);
    // On mobile this is what keeps the caret usable after the tap; the button's
    // pointer guards are what keep the soft keyboard from closing first.
    target.focus();
    return true;
}
