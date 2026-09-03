/**
 * Decides which runtime works a ticket, from the model its role is configured
 * with.
 *
 * The engine is not a deployment-wide switch, because the company does not have
 * one kind of worker: a role reviewing code can be worth a Claude subscription
 * turn while a triage role belongs on the local resident. The role already picks
 * its model in the plugin, so the model is the natural place for the decision to
 * live -- one setting, configured where the operator already configures roles.
 *
 * It reuses the `<providerID>/<modelID>` spelling roles already use:
 *
 *   claude/opus                        -> real Claude Code session
 *   codex/gpt-5.6-sol                  -> real Codex session
 *   litellm-auto/deepseek-v4-flash…    -> OpenCode, i.e. LiteLLM and the locals
 *
 * Anything unrecognised is OpenCode on purpose. That is where every model that
 * is not one of the two subscription CLIs lives, including every local one, and
 * it is the behaviour every existing role already has.
 */

/** Provider segments that mean "drive the real CLI", not "route through LiteLLM". */
const CLI_PROVIDERS = Object.freeze({ claude: 'claude', codex: 'codex' });

const optionalString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * Splits a role's model into the engine that serves it and the model name that
 * engine understands.
 *
 * OpenCode wants `{providerID, modelID}` and the CLIs want a bare name, so the
 * shape is converted here rather than in three engines that would each have to
 * know about the other two.
 */
export const resolveEngine = (model) => {
  const asString = optionalString(model);
  if (asString) {
    const slash = asString.indexOf('/');
    const providerID = slash > 0 ? asString.slice(0, slash) : null;
    const kind = providerID ? CLI_PROVIDERS[providerID.toLowerCase()] : null;
    if (kind) return { kind, model: asString.slice(slash + 1) || null };
    return { kind: 'opencode', model };
  }

  if (model && typeof model === 'object' && !Array.isArray(model)) {
    const providerID = optionalString(model.providerID);
    const kind = providerID ? CLI_PROVIDERS[providerID.toLowerCase()] : null;
    if (kind) return { kind, model: optionalString(model.modelID) ?? optionalString(model.id) };
    return { kind: 'opencode', model };
  }

  // No model at all is the house default, which is the local resident.
  return { kind: 'opencode', model: null };
};
