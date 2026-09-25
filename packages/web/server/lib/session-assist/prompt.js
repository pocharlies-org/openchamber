import { excerpt } from './context.js';

// Over budget the oldest turns are dropped only in steps of this many: the
// prompt goes to the session's own model, so consecutive assists on a session
// share a token prefix and hit the backend's prefix cache. Dropping one turn at
// a time would move the start of the transcript on every call and defeat that.
const TURN_DROP_CHUNK = 8;
const LANGUAGE_TURNS = 3;

const toolSummary = (tools) => {
  if (!tools?.length) return '';
  const counts = new Map();
  for (const name of tools) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(', ');
};

export function buildAssistSystemPrompt({ recap, suggestion }) {
  return [
    `Return exactly one JSON object with string fields: ${[recap ? '"recap"' : '', suggestion ? '"suggestion"' : ''].filter(Boolean).join(', ')}.`,
    recap ? 'recap is a reminder of the actual work accomplished or conclusion reached in the recent conversation. In at most 20 words, name the concrete behavior or subject and its current result. The reader wants to remember WHAT changed or was learned.' : '',
    recap ? 'Write the recap for the person using the app, not for someone reviewing its code. Name the feature and the concrete difference the user will notice. Replace generic "implemented and tested" summaries with what now works differently or what was learned. File paths, internal module names, test counts, and lists of checks belong in the recap only when they are the subject of the user\'s request. Preserve a specific finding or limitation when it changes the meaning of the result.' : '',
    recap ? 'For a closing exchange such as a commit, push, acknowledgment, or thank-you, summarize the substantive work from the preceding answers. Commit bookkeeping, authorship, branch names, and hashes are secondary and usually omitted. A recap saying only that optimizations or changes were committed does not serve this purpose.' : '',
    recap ? 'Use the latest state of that work. Distinguish recommendations from actions already performed, and implementations from verified deployments. Retain the reported conclusion without recalculating detailed lists. Earlier unrelated topics are not part of the recap.' : '',
    suggestion ? 'suggestion is optional. Return "" when the current request is satisfied or continuing requires a user decision. Otherwise return one concise message the user could send to continue specific unfinished work they requested.' : '',
    suggestion ? 'suggestion: return an empty string if the latest request has been satisfied, the next move requires the user\'s decision, or the context does not establish unfinished requested work. Finishing is a normal outcome.' : '',
    suggestion ? 'You are given the whole conversation, not just its end. Judge whether the request is satisfied against what the user actually asked for, not only against the latest reply.' : '',
    suggestion ? 'Otherwise write one concise, specific next message the user can send unchanged to continue the unfinished request. Use the user\'s voice addressing the agent.' : '',
    suggestion ? 'A request to analyze, explain, or recommend is satisfied by that analysis, explanation, or recommendation unless the user also asked for execution. An optional offer, an implementation plan, a caveat about untested platforms, or uncommitted work is not permission for a new task. Do not revive old requests after the user changes topic.' : '',
    'Language: all requested fields follow the latest user-authored communication, including the user\'s comments on quotes. Ignore the language of the quoted material, code, logs, assistant responses, and these instructions. For a language-neutral acknowledgment use recent user-authored communication. Keep technical names unchanged where useful.',
    recap && suggestion ? 'Keep recap and suggestion independent: recap may carry earlier substantive work forward, while suggestion must be justified by the current request, not by that earlier work.' : '',
    suggestion ? 'Only suggest work the coding agent can perform in the session. If the next action belongs to the user, such as checking their phone, choosing a design, or approving a change, return "". A suggestion is a message sent TO the agent, never a reminder addressed to the user.' : '',
  ].filter(Boolean).join('\n');
}

function renderTurn(turn, userText = turn.user.text, answerText = turn.assistant?.text ?? '') {
  const tools = toolSummary(turn.tools);
  return [
    `Turn ${turn.number}${turn.complete ? '' : ' (interrupted before a final response)'}`,
    'User message with attached context:', userText,
    ...(tools ? [`Tools the assistant used: ${tools}`] : []),
    turn.complete ? 'Assistant final response:' : 'Assistant progress before interruption:', answerText,
  ].join('\n');
}

const renderTurns = (turns) => turns.map((turn) => renderTurn(turn)).join('\n\n---\n\n');

export function buildAssistPrompt(turns, targets, charBudget) {
  // The whole session is sized against the model that answers, not a fixed cap.
  const budget = Math.floor(charBudget);
  if (!Number.isFinite(budget) || budget < 1_000 || !turns.length) return null;
  const languageBudget = Math.min(3_600, Math.floor(budget / 5));
  // The language follows the LATEST user-authored text, not the whole session.
  const language = excerpt(turns.slice(-LANGUAGE_TURNS).map((turn) => excerpt(turn.user.authored, 1_200)).filter(Boolean).join('\n'), languageBudget);
  const requested = [targets.recap ? 'a reminder of the recent substantive work in recap' : '', targets.suggestion ? 'an optional current next step in suggestion' : ''].filter(Boolean).join(', and ');
  const footer = `\n\n--- End of conversation evidence ---\n\nRecent user-authored communication, excluding attached quotes, oldest first:\n\n${language}\n\nReturn ${requested}.`;
  // Everything that varies per call (the language sample, the request) goes
  // AFTER the transcript, so the history stays an append-only prefix.
  const headerFor = (dropped) => (dropped > 0
    ? `The conversation, oldest first; its first ${dropped} turns are omitted.\n\n`
    : 'The whole conversation, oldest first, from the user\'s first message.\n\n');
  let dropped = 0;
  let body = renderTurns(turns);
  while (body.length > budget - headerFor(dropped).length - footer.length && dropped < turns.length - 1) {
    dropped = Math.min(dropped + TURN_DROP_CHUNK, turns.length - 1);
    body = renderTurns(turns.slice(dropped));
  }
  const header = headerFor(dropped);
  const available = budget - header.length - footer.length;
  if (body.length > available) {
    const turn = turns[turns.length - 1];
    const textBudget = available - renderTurn(turn, '', '').length;
    if (textBudget < 128) return null;
    const answer = turn.assistant?.text ?? '';
    const userBudget = Math.min(turn.user.text.length, Math.max(Math.floor(textBudget / 3), textBudget - answer.length));
    body = renderTurn(turn, excerpt(turn.user.text, userBudget), excerpt(answer, textBudget - userBudget));
  }
  return { text: header + body + footer, language };
}
