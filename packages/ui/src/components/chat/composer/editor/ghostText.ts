/**
 * Paints a suggestion behind the caret as unwritten text.
 *
 * The suggestion is not in the document: it is a widget past the last
 * character, so it cannot be selected, copied, sent, or reached with the
 * arrow keys, and the document the composer submits never contains it. It
 * becomes real text only when the caller inserts it.
 */

import { EditorView, WidgetType, Decoration, type DecorationSet } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

class GhostTextWidget extends WidgetType {
    constructor(readonly text: string) {
        super();
    }

    eq(other: GhostTextWidget): boolean {
        return other.text === this.text;
    }

    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = 'cm-composer-ghost';
        span.textContent = this.text;
        // It is a hint, not content: screen readers announcing it mid-line
        // would read the draft as something the user did not write.
        span.setAttribute('aria-hidden', 'true');
        return span;
    }

    /** Clicks land in the editor rather than being swallowed by the widget. */
    ignoreEvent(): boolean {
        return false;
    }
}

/**
 * `side: 1` keeps the widget after the caret when the caret sits at the end
 * of the document, which is the only place it is drawn.
 */
export function ghostTextExtension(text: string): Extension {
    if (!text) return [];
    return EditorView.decorations.compute(['doc'], (state): DecorationSet => {
        const end = state.doc.length;
        return Decoration.set([
            Decoration.widget({ widget: new GhostTextWidget(text), side: 1 }).range(end),
        ]);
    });
}
