# Composer

The chat composer: the prompt language, the editor that renders it, and
everything between typing and sending.

`ChatInput.tsx` (one directory up) is the orchestrator. It holds the composer's
own state and wires these modules together; it should not grow logic that
belongs to one of them.

`ChatContainer.tsx` keeps one `ChatInput` mounted while a new-session draft
becomes its first session. Draft-only UI first fades for 120ms while the editor
stays in place. The parent then moves the editor to its final session position
with a 180ms transform-only FLIP animation. Reduced-motion mode skips these
transitions. `session-ui-store.ts` marks sessions materialized from a submitted
draft, so selecting an existing session while a draft is open switches without
animation. Do not restore separate draft and session composer branches:
remounting the editor loses focus and interrupts the transition. Keep the
existing mobile fixed-position rules unchanged.

## Layers

| Directory | Owns |
|---|---|
| `language/` | What the text *means*: `@` references, `/` and `#` tokens, markdown, and which picker a caret asks for |
| `editor/` | The CodeMirror view that renders the language and owns the caret |
| `state/` | Composer state with a lifecycle: drafts, mobile shell, history, popup placement, draft targeting |
| `ghost/` | The suggestion drawn behind the caret: when to ask for it, and what comes back |
| `submit/` | Turning what the user has into what gets sent |
| `attachments/` | Files: paths, drop payloads |
| `ui/` | Presentation |
| `text.ts` | How inserted text meets the text already there |

## The prompt language

`language/` is the single source of truth for composer syntax. Everything that
needs to know what a token means — highlighting, send-time resolution, and the
autocomplete triggers — goes through it.

**This is the invariant that matters most in this module.** Before it existed,
the `@` rule was written four times with divergent cleanup and the `/` rule
three times with different valid character sets, so a token could be painted as
a reference and then not resolve as one. Adding a construct meant finding every
copy.

- `mentions.ts` — `@` references. The `start..end` span is the reference
  itself and is what gets highlighted; in `see @a/b.ts,` the comma is sentence
  punctuation, not part of the file being referenced. Mentions are plain
  editable text: deleting a character edits the token and reopens the mention
  picker, the same way `/skill` tokens behave — not an atomic delete.
- `prefixTokens.ts` — `/command`, `/skill`, `#snippet`. Scanning is deliberately
  generous; **membership in the command, skill or snippet registry is the
  authority**, not the pattern. An unknown `/token` stays plain prose.
- `triggers.ts` — which picker a caret position asks for. Exactly one can be
  active, with precedence `command > skill > snippet > mention`.
- `tokenize.ts` — one pass producing every highlight range. Adding a construct
  to the language means adding it here, once.

## The editor

`editor/` wraps CodeMirror. The document is a plain string: `getValue()` is
exactly what gets sent, so nothing downstream serializes a rich document model
back into a prompt.

The composer previously painted a transparent `<textarea>` over a mirror
`<div>`. That restricted highlighting to styles which do not change glyph
advance width — colour, background, underline — because anything else made the
mirror drift out from under the caret. Bold and italic were impossible, and the
overlay was disabled outright on mobile, where wrapped text drifted anyway.
**Those constraints are gone**; adding a width-affecting style is now a
question of design, not of feasibility.

Selection rendering: every device runs CodeMirror's `drawSelection()` — it
keeps typing on the drawn-selection code path, and removing it makes
CodeMirror enforce cursor association on the native selection, which iOS
answers with severe input lag. **That much is not platform-specific and must
not be undone.** What differs is who paints the selection, and
`composerSelectionExtension` (`editor/theme.ts`) picks that per platform.

When CodeMirror 6.43.9's iOS predicate does not match,
`composerNativeSelectionExtension` layers over `drawSelection()`: it re-shows
the native selection, and — only while a range is selected — the native caret,
hiding the painted layers those replace. The native selection is the one that
shows for two reasons: the painted layer sits behind the content, so tokens
with their own background (inline code, fences) cover it completely; and the
platform's selection drag handles attach to the visible native selection and
take their colour from the caret, so a transparent caret means invisible
handles. The range-only caret scoping is load-bearing — a native caret visible
while typing makes the browser re-render its caret UI after every keystroke,
felt as severe input lag.

When CodeMirror 6.43.9's exact iOS predicate matches,
`composerIOSSelectionExtension` leaves selection-handle geometry and appearance
to CodeMirror. CodeMirror puts the handles in `.cm-selectionLayer`, normally at
`z-index: -1`; the extension raises that layer above the content so opaque
token backgrounds cannot cover them, and leaves it transparent to touch.
The handle dots extend 8px past their range; matching scroller padding and
negative margin expand the clip area without moving the text or changing the
composer height. iOS still paints its taller system selection overlay even
when CSS makes `::selection` transparent. The extension therefore suppresses
CodeMirror's synthetic selection rectangles on iOS while leaving its handles,
cursor path and `nativeSelectionHidden` facet active. Otherwise the grey system
highlight and themed rectangle overlap with visibly different heights.
Do not add a second custom layer or custom handles here: overlapping translucent
rectangles make selection darker at their seams and imitated handles drift from
the geometry WebKit actually manipulates. What iOS avoids is installing the
native-selection workaround above: explicitly restoring native paint and caret
makes WebKit re-measure them after every decoration redraw, and the composer
rebuilds every decoration on every keystroke. That cost is felt worst during
IME composition.

The non-iOS native selection tint comes from `--primary`, not the selection
token: themes define `--interactive-selection` with its own alpha, so mixing it
with transparent again is nearly invisible. The iOS system overlay owns its
visible selection fill.

`composerLanguage.ts` retokenizes the whole document on every change. The
composer holds a prompt, not a source file: it is short enough that a full pass
is cheaper and far simpler than incremental mapping, and it keeps the editor
and the send path reading the same grammar.

## Ordering rules worth knowing

- `editor/ComposerEditor.tsx` forwards a click on the composer's padding by
  focusing the view *before* setting the selection: CodeMirror reveals its
  drawn caret through a class it only writes while applying an update, so the
  selection has to be the update that follows the focus.
- `submit/buildOutgoingMessage.ts` flattens queued messages, the composer text,
  inline comments and context into OpenCode's one-primary-plus-parts shape. The
  oldest queued message becomes primary; **inline comments attach to the last
  body the user authored** rather than becoming their own part; PR instructions
  precede the PR diff.
- `state/useComposerDraft.ts` — a draft belongs to a (runtime, directory,
  session) identity. Writes are debounced while typing but forced at every edge
  where the page may stop running, because a pending timer is not a saved
  draft. Two orderings are load-bearing: the debounced write is skipped once
  while a draft is being restored, and a deleted draft's empty signature is
  recorded before a queued write could resurrect it.
- `state/useDraftTarget.ts` — the draft can target a directory that does not
  exist yet (a worktree being created). It must survive not appearing in the
  branch list, or the selector snaps back to the project root mid-creation.

## Ghost autocomplete

`ghost/` predicts the text the user would type next and draws it behind the
caret. `Tab` takes it; anything else dismisses it. The suggestion is a
CodeMirror widget past the last character, never document text — `getValue()`
cannot return it, so an unaccepted suggestion can never be sent.

The following behavior is load-bearing:

- **The empty composer is the primary case.** While the window is visible and
  focused, 15 seconds of inactivity asks for the whole message the user would
  send next. A stale trailing-assistant activity fallback does not suppress the
  first request, while an authoritative busy/retry status does. After the first
  server reconciliation, the fallback cannot keep polling. An authoritative
  busy-to-idle turn edge remains an immediate trigger; a fallback-busy state
  resolving to idle does not bypass the 15-second wait. Identical
  history-generation/turn-count/draft fingerprints are requested only once,
  including model misses, and requests retain a 30-second start-to-start floor.
- **An unfinished assistant record is only a temporary activity fallback.** An
  attached error settles it immediately. Without an error it remains active
  while its message/part heartbeat is newer than 90 seconds, then expires so a
  process-crash orphan cannot silence autocomplete forever. Authoritative
  busy/retry status still wins and is never expired by this fallback timeout.
- **Nothing is requested unless the window is visible and focused.** The idle
  interval is stopped while hidden or blurred and restarts its full 15-second
  wait when the workspace returns to the foreground.
- **The server owns the cacheable context per session.** Clients send only the
  session identity, directory, and draft. The server reconciles authoritative
  history and suppresses duplicate prefix-and-draft model calls across clients.
  The server rebuilds deterministically from OpenCode history after restart and
  retains entries under a one-hour TTL and 100-session LRU bound, so browser and
  mobile share byte-identical prefixes.
- **The prompt is BASE + append-only LEDGER + DRAFT + fixed SUFFIX.** BASE is
  the versioned system prompt plus the first user message (2 KB maximum). BASE
  plus LEDGER has a 16 KB budget; crossing it deterministically rebases below
  8 KB on turn boundaries. BASE has absolute priority, followed by whole user
  messages from newest to oldest, then first sentences from assistant messages.
  Entries that do not fit are dropped rather than summarized, and even an
  oversized user-only history degrades to a bounded prompt instead of rejecting
  autocomplete. Tool output and synthetic text never enter the ledger.
- Every request reports `prefixHash`, `prefixBytes`, `generation`, and
  `turnCount`. The hash can prove byte stability; `cachedTokens` cannot prove
  cache reuse because the deployed provider commonly reports it as null/zero.

An empty draft is a first-class case, not a skip: right after a turn settles
there is no draft, and a whole suggested next message is the most useful thing
the feature does.

The server side is `packages/web/server/lib/composer-ghost/`. It defaults to
`gpt-5.4-mini` and still sends `max_completion_tokens`, never `max_tokens`.

## Mobile

`state/useMobileComposerShell.ts` and `state/useMobileViewportPin.ts` are
mostly not state machines but corrections for specific platform behaviors:
mobile browsers dismissing the keyboard before a tap's click lands, iOS
refusing programmatic focus outside a gesture, WebKit leaving the layout
viewport panned after the keyboard hides, overlay chains handing off through a
frame where nothing is open.

**Every timeout and `flushSync` in them has a reason recorded next to it, and
none of them is verifiable outside a real device.** Change them only against
hardware.

## Side conversations

Desktop and web composers expose side conversations through the built-in
`@pocharlies/openchamber-side-chat` UI-plugin contribution. The contribution is
declarative: it supplies the `/btw` and `/side` aliases, the composer-button
placement, and lifecycle policy. `ChatInput.tsx` remains the trusted host that
creates the child session, opens its writable context-panel chat tab, and sends
an optional command argument. Plugin manifests cannot execute renderer code or
call the SDK directly.

`lib/uiPlugins.ts` is the minimal host extension API. It validates versioned
JSON-shaped manifests before registration, rejects unsupported lifecycle policy
values, prevents duplicate IDs, and returns an unregister callback. Package
discovery feeds this API from the authenticated `/api/ui-plugins/catalog`
route. `stores/useUIPluginsStore.ts` keeps the last valid catalog when a refresh
fails and persists only the client's disabled IDs. The Chat settings page can
therefore enable or disable a contribution immediately without restarting.
Discovery must not become a remote-module or arbitrary-JavaScript loader.

The same declarative host API accepts `composerMetrics` contributions. The
generic `ComposerMetricsSurface` renders supported contributions in the footer;
it never executes plugin code or branches on the Stream Metrics contribution
ID. `@pocharlies/openchamber-stream-metrics` uses that surface on web and
Desktop, the compact form on hosted and Capacitor mobile, and declares VS Code
unsupported. The metric tracker lives in sync rather than `ChatInput`, and the
footer subscribes to the active runtime-directory-session snapshot. It also
reads only that session's message bucket when the bucket changes so opening or
reloading Web can hydrate the latest completed assistant's authoritative token
counters; streaming part deltas remain isolated in the tracker and do not
rerender the footer.

Side conversations are unavailable in the mobile and VS Code surfaces and
cannot be started from an embedded side-chat composer. They inherit the parent
composer's provider, model, agent, and variant, but their result is never
automatically inserted into the parent conversation.

## Testing

The package has no DOM test environment, so coverage stops at the state and
logic layers: the language, the submit assembly, path and drop handling, text
splicing, message history, and the CodeMirror language extension at the
`EditorState` level.

Rendering, focus, keyboard behavior, IME and WKWebView are **not covered by
tests** and are verified by hand. Do not report a change to them as validated
on the strength of type-check and unit tests.

Run tests per file (`bun test <path>`): `mock.module` is process-global, so
suites that install module mocks are order-dependent.
