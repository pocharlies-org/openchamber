import { describe, expect, it } from 'vitest';
import { buildAssistSystemPrompt } from './prompt.js';

/**
 * The suggestion is the one field the user never sees when it is empty, so its
 * wording is a measured contract, not prose. Feeding the model the whole
 * session and telling it to judge the request "against what the user actually
 * asked for" made it declare the opening request satisfied and answer `""` far
 * more often (on this fork: 16% of assists carried a suggestion before that
 * change, 5% after). Silence is still a correct outcome — what must not happen
 * is the prompt asking for it by default.
 */
describe('session assist instructions', () => {
  it('asks for the step still owed, and keeps silence a valid answer', () => {
    const system = buildAssistSystemPrompt({ recap: true, suggestion: true });

    expect(system).toContain('the user\'s most recent request, not against the one that opened the session');
    expect(system).toContain('a step the agent could still take in this session remains owed is unfinished work');
    expect(system).toContain('not for an answer that merely ends politely');

    expect(system).toContain('return an empty string if the latest request has been satisfied');
    expect(system).toContain('Finishing is a normal outcome');

    // Restoring the appetite must not restore invented follow-up work.
    expect(system).toContain('is not permission for a new task');
    expect(system).toContain('Do not revive old requests after the user changes topic');
  });

  it('asks only for the fields the settings want', () => {
    const recapOnly = buildAssistSystemPrompt({ recap: true, suggestion: false });
    expect(recapOnly).toContain('"recap"');
    expect(recapOnly).not.toContain('suggestion');

    const suggestionOnly = buildAssistSystemPrompt({ recap: false, suggestion: true });
    expect(suggestionOnly).toContain('"suggestion"');
    expect(suggestionOnly).not.toContain('recap is a reminder');
  });
});
