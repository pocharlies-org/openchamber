import { describe, expect, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';
import {
    GHOST_SUFFIX,
    GHOST_SYSTEM_PROMPT,
    buildGhostMessages,
    ghostFingerprint,
    sanitizeGhostText,
    sanitizeGhostTextForCurrentDraft,
    turnsFromMessages,
} from '../ghostCompletion';

const textPart = (text: string, extra: Record<string, unknown> = {}) =>
    ({ type: 'text', text, ...extra }) as unknown as Part;

describe('turnsFromMessages', () => {
    test('joins the text parts of each message', () => {
        const messages = [
            { id: 'm1', role: 'user' },
            { id: 'm2', role: 'assistant' },
        ];
        const parts: Record<string, Part[]> = {
            m1: [textPart('arregla el stock')],
            m2: [textPart('he mirado'), textPart('el controlador')],
        };

        expect(turnsFromMessages(messages, (id) => parts[id] ?? [])).toEqual([
            { role: 'user', text: 'arregla el stock' },
            { role: 'assistant', text: 'he mirado\nel controlador' },
        ]);
    });

    test('skips messages whose parts are not loaded rather than emitting empty turns', () => {
        const messages = [
            { id: 'm1', role: 'user' },
            { id: 'm2', role: 'assistant' },
            { id: 'm3', role: 'user' },
        ];
        const parts: Record<string, Part[]> = {
            m1: [textPart('primera')],
            m3: [textPart('tercera')],
        };

        expect(turnsFromMessages(messages, (id) => parts[id] ?? [])).toEqual([
            { role: 'user', text: 'primera' },
            { role: 'user', text: 'tercera' },
        ]);
    });

    test('ignores non-text and synthetic parts', () => {
        const messages = [{ id: 'm1', role: 'user' }];
        const parts = [
            textPart('<system-reminder>oculto</system-reminder>', { synthetic: true }),
            { type: 'tool', tool: 'bash' } as unknown as Part,
            textPart('visible'),
        ];

        expect(turnsFromMessages(messages, () => parts)).toEqual([
            { role: 'user', text: 'visible' },
        ]);
    });

    test('keeps the newest turns when the history is longer than the limit', () => {
        const messages = Array.from({ length: 30 }, (_, index) => ({
            id: `m${index}`,
            role: index % 2 === 0 ? 'user' : 'assistant',
        }));

        const turns = turnsFromMessages(messages, (id) => [textPart(id)], 4);
        expect(turns.map((turn) => turn.text)).toEqual(['m26', 'm27', 'm28', 'm29']);
    });
});

describe('buildGhostMessages', () => {
    test('puts the fixed prefix first and the instruction last, after the draft', () => {
        const messages = buildGhostMessages(
            [{ role: 'user', text: 'hola' }],
            'vale, ahora',
        );

        expect(messages[0]).toEqual({ role: 'system', content: GHOST_SYSTEM_PROMPT });
        expect(messages[1]).toEqual({ role: 'user', content: 'hola' });
        expect(messages[2].content).toBe(`vale, ahora${GHOST_SUFFIX}`);
    });

    test('keeps everything but the draft byte-identical between calls', () => {
        const turns = [{ role: 'assistant' as const, text: 'listo' }];
        const first = buildGhostMessages(turns, 'ab');
        const second = buildGhostMessages(turns, 'abc');

        expect(second.slice(0, -1)).toEqual(first.slice(0, -1));
        expect(second.at(-1)!.content.endsWith(GHOST_SUFFIX)).toBe(true);
    });

    test('still asks with an empty draft', () => {
        const messages = buildGhostMessages([{ role: 'assistant', text: 'listo' }], '');
        expect(messages.at(-1)!.content).toBe(GHOST_SUFFIX);
    });
});

describe('ghostFingerprint', () => {
    test('changes with the draft', () => {
        const turns = [{ role: 'user' as const, text: 'hola' }];
        expect(ghostFingerprint(turns, 'a')).not.toBe(ghostFingerprint(turns, 'ab'));
    });

    test('changes when the history grows', () => {
        const draft = 'a';
        const before = ghostFingerprint([{ role: 'user', text: 'hola' }], draft);
        const after = ghostFingerprint(
            [{ role: 'user', text: 'hola' }, { role: 'assistant', text: 'listo' }],
            draft,
        );
        expect(before).not.toBe(after);
    });
});

describe('sanitizeGhostText', () => {
    test('returns null for nothing usable', () => {
        expect(sanitizeGhostText(null, '')).toBeNull();
        expect(sanitizeGhostText(undefined, '')).toBeNull();
        expect(sanitizeGhostText('   ', '')).toBeNull();
    });

    test('drops a restatement of the draft', () => {
        expect(sanitizeGhostText('vale, ahora revisa el stock', 'vale, ahora'))
            .toBe(' revisa el stock');
    });

    test('unwraps quotes and code fences', () => {
        expect(sanitizeGhostText('"revisa el stock"', '')).toBe('revisa el stock');
        expect(sanitizeGhostText('```\nrevisa el stock\n```', '')).toBe('revisa el stock');
    });

    test('adds the separating space the draft is missing', () => {
        expect(sanitizeGhostText('revisa', 'vale, ahora')).toBe(' revisa');
        expect(sanitizeGhostText('revisa', 'vale, ahora ')).toBe('revisa');
        expect(sanitizeGhostText(', revisa', 'vale')).toBe(', revisa');
    });

    test('does not prepend a space when the draft is empty', () => {
        expect(sanitizeGhostText('revisa el stock', '')).toBe('revisa el stock');
    });

    test('clamps a runaway suggestion', () => {
        const long = 'a'.repeat(900);
        expect(sanitizeGhostText(long, '')!.length).toBe(400);
    });

    test('returns null when the draft was the whole answer', () => {
        expect(sanitizeGhostText('vale, ahora', 'vale, ahora')).toBeNull();
    });
});

describe('sanitizeGhostTextForCurrentDraft', () => {
    test('keeps a late answer when the user only extended the requested draft', () => {
        expect(sanitizeGhostTextForCurrentDraft(
            'vale, ahora reviso el stock',
            'vale',
            'vale, ahora',
        )).toBe(' reviso el stock');
    });

    test('removes overlap from a continuation-only answer', () => {
        expect(sanitizeGhostTextForCurrentDraft(
            ', ahora reviso el stock',
            'vale',
            'vale, ahora',
        )).toBe(' reviso el stock');
    });

    test('drops a late answer after a non-append edit', () => {
        expect(sanitizeGhostTextForCurrentDraft(
            'vale, ahora reviso el stock',
            'vale',
            'de acuerdo',
        )).toBeNull();
    });
});
