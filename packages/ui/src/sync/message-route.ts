/**
 * How a message went: a prompt; an OpenCode command (its template expanded on
 * the command route, with the attached context admitted ahead); an engine's
 * own command (`engine-command`, Claude Code expands it); or a shell run.
 */
export type MessageRoute = 'command' | 'prompt' | 'shell' | 'engine-command'

/**
 * Whether a send on this route carried the standing project knowledge given to
 * it, so it may be recorded as delivered. An engine's own command does not
 * carry it (a command is not where it belongs); a shell run carries nothing.
 */
export const routeCarriesKnowledge = (route: MessageRoute): boolean => route === 'prompt' || route === 'command'
