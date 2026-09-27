/**
 * Mobile display of a Claude model name carrying the multi-account quota.
 *
 * The `opencode-claude` plugin (~/src/opencode-claude, `quotaNameSuffix` in
 * src/models.ts) publishes the account's remaining quota INSIDE the model
 * name — `🏠 Opus 5.5 · 🟢 93% 54m · 🔵 15% 2d 18h` — because the name is the
 * one string it controls that every host renders next to the composer. The
 * plugin runs server-side and cannot know which host is reading, so the
 * phone-width problem is the UI's: on the mobile pill the name shares one
 * line with the agent button and truncates mid-countdown.
 *
 * The compaction keeps every signal and drops only false precision: a
 * countdown keeps its leading unit (`2d 18h` → `2d`, `2h 20m` → `2h`), the
 * same rounding the plugin itself applies once a window is days out.
 * Percentages, the `🟢 ?` unknown and the `🔴 bloqueada` marker are left as
 * published.
 */

/** Marks the plugin uses per window: green 5h, blue 7d, red hard block. */
const QUOTA_MARKS = '\u{1F7E2}\u{1F535}\u{1F534}';
const HAS_QUOTA_MARK = new RegExp(`[${QUOTA_MARKS}]`, 'u');
/** A quota segment whose countdown carries a second unit worth dropping. */
const SECOND_COUNTDOWN_UNIT = new RegExp(
  `^([${QUOTA_MARKS}] (?:\\d{1,3}% |bloqueada )?)(\\d+[hd]) \\d+[mh]$`,
  'u',
);

/** The plugin joins the name and each window with ' · ' (U+00B7). */
const SEGMENT_SEPARATOR = ' \u00B7 ';

export const compactClaudeQuotaName = (name: string): string => {
  if (!HAS_QUOTA_MARK.test(name)) return name;
  return name
    .split(SEGMENT_SEPARATOR)
    .map((segment) => segment.replace(SECOND_COUNTDOWN_UNIT, '$1$2'))
    .join(SEGMENT_SEPARATOR);
};
