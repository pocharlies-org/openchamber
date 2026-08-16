import { describe, expect, test } from 'bun:test';

import { insertGhostSuggestion, type GhostInsertTarget } from '../acceptGhost';

const targetFor = (value: string) => {
    const calls: { from: number; to: number; text: string }[] = [];
    let focused = 0;
    const target: GhostInsertTarget = {
        getValue: () => value,
        replaceRange: (from, to, text) => {
            calls.push({ from, to, text });
        },
        focus: () => {
            focused += 1;
        },
    };
    return { target, calls, focusCount: () => focused };
};

describe('insertGhostSuggestion', () => {
    test('inserts at the end of the document, which is where the ghost is drawn', () => {
        const { target, calls } = targetFor('quiero un boton');

        expect(insertGhostSuggestion(target, ' para aceptar')).toBe(true);
        expect(calls).toEqual([{ from: 15, to: 15, text: ' para aceptar' }]);
    });

    test('collapses the range so nothing the user wrote is replaced', () => {
        const { target, calls } = targetFor('hola');

        insertGhostSuggestion(target, ' mundo');

        expect(calls[0]?.from).toBe(calls[0]?.to);
    });

    test('restores focus, so the mobile caret survives the tap', () => {
        const { target, focusCount } = targetFor('draft');

        insertGhostSuggestion(target, ' mas');

        expect(focusCount()).toBe(1);
    });

    test('an empty document still inserts at 0', () => {
        const { target, calls } = targetFor('');

        expect(insertGhostSuggestion(target, 'texto entero')).toBe(true);
        expect(calls).toEqual([{ from: 0, to: 0, text: 'texto entero' }]);
    });

    test('does nothing without a suggestion', () => {
        const { target, calls, focusCount } = targetFor('draft');

        expect(insertGhostSuggestion(target, null)).toBe(false);
        expect(insertGhostSuggestion(target, '')).toBe(false);
        expect(calls).toEqual([]);
        expect(focusCount()).toBe(0);
    });

    test('does nothing without an editor', () => {
        expect(insertGhostSuggestion(null, 'texto')).toBe(false);
    });
});
