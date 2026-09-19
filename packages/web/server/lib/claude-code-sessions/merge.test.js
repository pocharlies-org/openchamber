import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractClaudeSessionId, mergeClaudeCodeSessions, prefixClaudeTitle } from "./merge.js";

const RAW_ID = "a868b39e-dd1f-453e-8dd0-594033639382";

const diskEntry = (overrides = {}) => ({
  id: RAW_ID,
  directory: "/home/dibanez/k8s/openchamber-side-chat",
  title: "cto-SC-688",
  time: { created: 100, updated: 200 },
  live: false,
  tokens: { input: 10, output: 5, reasoning: 0, cache_read: 0, cache_creation: 0 },
  ...overrides,
});

describe("extractClaudeSessionId", () => {
  it("extracts the raw uuid from the observed runtime id shape (ses_ccc + uuid)", () => {
    assert.equal(extractClaudeSessionId({ id: `ses_ccc${RAW_ID}` }), RAW_ID);
  });

  it("also matches a runtime id that is just ses_ + raw uuid", () => {
    assert.equal(extractClaudeSessionId({ id: `ses_${RAW_ID}` }), RAW_ID);
  });

  it("never matches OpenCode ids (no uuid shape)", () => {
    assert.equal(extractClaudeSessionId({ id: "ses_f4dbce944ffexdVPwcWQ23hAoP" }), null);
    assert.equal(extractClaudeSessionId({ id: "not-a-session" }), null);
    assert.equal(extractClaudeSessionId(undefined), null);
  });
});

describe("prefixClaudeTitle", () => {
  it("prefixes once and never doubles", () => {
    assert.equal(prefixClaudeTitle("Hola"), "Claude: Hola");
    assert.equal(prefixClaudeTitle("Claude: Hola"), "Claude: Hola");
    assert.equal(prefixClaudeTitle(null), "Claude: Claude session");
  });
});

describe("mergeClaudeCodeSessions", () => {
  it("folds the runtime duplicate into the disk entry: raw id wins, runtime cost/tokens inherited", () => {
    const upstream = [
      { id: "ses_f4dbce944ffexdVPwcWQ23hAoP", title: "OpenCode session", directory: "/proj/oc", time: { updated: 5 } },
      {
        id: `ses_ccc${RAW_ID}`,
        title: "cto-SC-688",
        directory: "/home/dibanez/k8s",
        time: { created: 1, updated: 2 },
        cost: 3.5,
        tokens: { input: 99, output: 11, reasoning: 0 },
        metadata: { claude: { directory: "/home/dibanez/k8s/openchamber-side-chat" } },
      },
    ];
    const out = mergeClaudeCodeSessions(upstream, { diskSessions: [diskEntry()] });

    assert.equal(out.length, 2);
    const merged = out.find((s) => s.id === RAW_ID);
    assert.ok(merged, "merged entry must carry the raw jsonl id");
    assert.equal(out.some((s) => s.id === `ses_ccc${RAW_ID}`), false, "prefixed duplicate must be dropped");
    assert.equal(merged.title, "Claude: cto-SC-688");
    assert.equal(merged.directory, "/home/dibanez/k8s/openchamber-side-chat", "real cwd beats the runtime directory");
    assert.equal(merged.time.updated, 200, "disk last timestamp wins");
    assert.equal(merged.live, false);
    assert.equal(merged.cost, 3.5);
    assert.deepEqual(merged.tokens, { input: 99, output: 11, reasoning: 0 });
    // OpenCode entry untouched.
    assert.deepEqual(out[0], upstream[0]);
  });

  it("keeps disk token counters when the runtime reports untracked zeros", () => {
    const upstream = [{ id: `ses_ccc${RAW_ID}`, cost: 0, tokens: { input: 0, output: 0, reasoning: 0 } }];
    const out = mergeClaudeCodeSessions(upstream, { diskSessions: [diskEntry()] });
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].tokens, { input: 10, output: 5, reasoning: 0, cache_read: 0, cache_creation: 0 });
    assert.equal(out[0].cost, 0);
  });

  it("passes through runtime claude sessions without a disk counterpart", () => {
    const runtimeOnly = { id: "ses_ccc99999999-0000-4000-8000-000000000009", title: "gone from disk" };
    const out = mergeClaudeCodeSessions([runtimeOnly], { diskSessions: [diskEntry()] });
    assert.deepEqual(out[0], runtimeOnly, "unmatched runtime entry untouched");
    assert.equal(out.length, 2, "the unrelated disk entry is still appended");
    assert.equal(out[1].id, RAW_ID);
  });

  it("appends disk-only sessions and applies the directory filter to them", () => {
    const diskOnly = diskEntry({ id: "eeeeeeee-0000-4000-8000-000000000001", directory: "/home/dibanez/other" });
    const matching = diskEntry({ id: "eeeeeeee-0000-4000-8000-000000000002", directory: "/home/dibanez/k8s/openchamber-side-chat/" });

    const global = mergeClaudeCodeSessions([], { diskSessions: [diskEntry(), diskOnly, matching] });
    assert.deepEqual(global.map((s) => s.id).sort(), [RAW_ID, diskOnly.id, matching.id].sort());
    assert.ok(global.every((s) => s.title.startsWith("Claude: ")));
    assert.ok(global.every((s) => typeof s.live === "boolean"));

    const scoped = mergeClaudeCodeSessions([], {
      diskSessions: [diskEntry(), diskOnly, matching],
      directory: "/home/dibanez/k8s/openchamber-side-chat",
    });
    assert.deepEqual(scoped.map((s) => s.id).sort(), [RAW_ID, matching.id].sort(), "trailing slash tolerated, other dirs excluded");
  });

  it("keeps a folded runtime entry even when the disk cwd differs from the requested directory", () => {
    // The runtime listed the session under its own directory; the disk entry
    // carries the real cwd. The session must not disappear from the scoped
    // response just because the two disagree.
    const upstream = [{ id: `ses_ccc${RAW_ID}`, directory: "/requested/dir" }];
    const out = mergeClaudeCodeSessions(upstream, {
      diskSessions: [diskEntry({ directory: "/real/cwd" })],
      directory: "/requested/dir",
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, RAW_ID);
    assert.equal(out[0].directory, "/real/cwd");
  });

  it("returns non-array payloads untouched", () => {
    const error = { error: "upstream failed" };
    assert.equal(mergeClaudeCodeSessions(error, { diskSessions: [diskEntry()] }), error);
  });
});
