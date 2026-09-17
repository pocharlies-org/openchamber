const MAX_ROLES = 50;
const MAX_ID_CHARS = 64;
const MAX_TITLE_CHARS = 120;
const MAX_PATTERN_CHARS = 200;
const MAX_PROMPT_CHARS = 4000;

const MAX_APP_SLUG_CHARS = 100;

const ROLE_ID = /^[a-z][a-z0-9-]*$/;
const APP_SLUG = /^[a-z0-9][a-z0-9-]*$/;
// and a hardcoded list would silently drop a customer's newer rule.

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

const requiredString = (value, field, limit) => {
  const text = trimmed(value);
  if (!text) throw new Error(`Invalid role config: ${field}`);
  if (text.length > limit) throw new Error(`Invalid role config: ${field} exceeds ${limit} characters`);
  return text;
};


/**
 * The GitHub identity of the role's bot (its GitHub App), arriving as
 * installation DATA: appId/installationId live in the plugin config, never as
 * files on the OpenCode host. The private key deliberately has NO field here —
 * this config travels through Forge storage and webtriggers, so a key in it
 * would be a leak. It stays in the secret store, looked up by slug.
 */
const parseGitHub = (value, field) => {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error(`Invalid role config: ${field}`);
  for (const key of ['pem', 'privateKey', 'private_key', 'clientSecret', 'client_secret', 'webhookSecret', 'webhook_secret']) {
    if (value[key] !== undefined) {
      throw new Error(`Invalid role config: ${field}.${key} — secrets never travel in role config; keep them in the secret store`);
    }
  }
  if (!Number.isInteger(value.appId) || value.appId <= 0) {
    throw new Error(`Invalid role config: ${field}.appId must be a positive integer`);
  }
  if (!Number.isInteger(value.installationId) || value.installationId <= 0) {
    throw new Error(`Invalid role config: ${field}.installationId must be a positive integer`);
  }
  let slug = null;
  if (value.slug !== undefined && value.slug !== null) {
    slug = requiredString(value.slug, `${field}.slug`, MAX_APP_SLUG_CHARS);
    if (!APP_SLUG.test(slug)) throw new Error(`Invalid role config: ${field}.slug`);
  }
  return { appId: value.appId, installationId: value.installationId, slug };
};


/**
 * Normalizes one role definition arriving as DATA from the installation.
 *
 * WHAT THE INSTALLATION OWNS, AND WHAT IT NO LONGER DOES
 * -----------------------------------------------------
 * A role here says WHO does the work: its id, its title, its GitHub identity and
 * a prompt hint. It does not say what that role is allowed to run, and it does
 * not choose the model.
 *
 * Those two moved to the role folder (`company-office/roles/<role>/<mode>/`) for
 * one reason: a permission boundary edited through an admin page is a security
 * decision with no review and no history. In a folder it is versioned, it is
 * diffed, and the mode it belongs to is visible next to it. Splitting them also
 * removes the worse failure -- the same boundary defined in two places, drifting,
 * with an undocumented precedence deciding which one actually applied.
 *
 * `permission` and `model` are IGNORED rather than rejected when an installation
 * still sends them: saved configurations predate this split, and failing them
 * would take the whole company down over a field that is now inert.
 */
export const parseRole = (value, index = 0) => {
  const field = `roles[${index}]`;
  if (!isRecord(value)) throw new Error(`Invalid role config: ${field}`);

  const id = requiredString(value.id, `${field}.id`, MAX_ID_CHARS);
  if (!ROLE_ID.test(id)) throw new Error(`Invalid role config: ${field}.id`);

  return {
    id,
    title: value.title === undefined || value.title === null
      ? id
      : requiredString(value.title, `${field}.title`, MAX_TITLE_CHARS),
    promptHint: trimmed(value.promptHint) ? trimmed(value.promptHint).slice(0, MAX_PROMPT_CHARS) : null,
    github: parseGitHub(value.github, `${field}.github`),
  };
};

export const parseRoleConfig = (value) => {
  const list = isRecord(value) ? value.roles : value;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('Invalid role config: roles must be a non-empty array');
  }
  if (list.length > MAX_ROLES) {
    throw new Error(`Invalid role config: exceeds ${MAX_ROLES} roles`);
  }
  const roles = list.map((role, index) => parseRole(role, index));
  const ids = roles.map((role) => role.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Invalid role config: duplicate role id');
  }
  return {
    roles,
    byId: new Map(roles.map((role) => [role.id, role])),
  };
};
