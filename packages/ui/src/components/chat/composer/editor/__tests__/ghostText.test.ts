import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { EditorView, type DecorationSet } from '@codemirror/view';

import { ghostTextExtension } from '../ghostText';

const stateWith = (doc: string, ghost: string) =>
    EditorState.create({ doc, extensions: ghostTextExtension(ghost) });

/**
 * The decoration sets this facet holds as values rather than functions. Those
 * are the ones the view draws directly, which is the path a widget has to be
 * on to be painted at all.
 */
const staticDecorationSets = (state: EditorState): DecorationSet[] =>
    state.facet(EditorView.decorations).filter((source): source is DecorationSet => typeof source !== 'function');

const widgets = (state: EditorState) => {
    const found: Array<{ from: number; to: number; text: string }> = [];
    for (const set of staticDecorationSets(state)) {
        set.between(0, state.doc.length, (from, to, value) => {
            const widget = (value.spec as { widget?: { text?: string } }).widget;
            if (widget?.text !== undefined) found.push({ from, to, text: widget.text });
        });
    }
    return found;
};

describe('ghostTextExtension', () => {
    test('contributes no decoration without a suggestion', () => {
        expect(widgets(stateWith('hola', ''))).toEqual([]);
    });

    test('places the widget past the last character', () => {
        expect(widgets(stateWith('vale, ahora', ' revisa el stock'))).toEqual([
            { from: 11, to: 11, text: ' revisa el stock' },
        ]);
    });

    test('places the widget at the start of an empty document', () => {
        expect(widgets(stateWith('', 'revisa el stock'))).toEqual([
            { from: 0, to: 0, text: 'revisa el stock' },
        ]);
    });

    test('is provided as a value, not a function, so the view draws it', () => {
        // A function-provided source is called after the viewport is computed
        // and may not introduce block widgets; a value-provided one has no
        // such limit. Keeping this on the value path is deliberate.
        expect(staticDecorationSets(stateWith('hola', 'mundo')).length).toBe(1);
    });

    test('follows the end of the document as it changes', () => {
        const state = stateWith('vale', ' revisa');
        const grown = state.update({ changes: { from: 4, insert: ', ahora' } }).state;
        expect(widgets(grown)).toEqual([{ from: 11, to: 11, text: ' revisa' }]);
    });

    test('never becomes document text', () => {
        const state = stateWith('vale', ' revisa el stock');
        expect(state.doc.toString()).toBe('vale');
    });
});
