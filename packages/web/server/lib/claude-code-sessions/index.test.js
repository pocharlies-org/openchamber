import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { createClaudeCodeSessionIndex } from "./index.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sessions-index-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const makeProjectsDir = (name) => {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const writeJsonl = (dir, id, records) => {
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return file;
};

const baseRecords = (sessionId, cwd, ts) => [
  { type: "queue-operation", operation: "enqueue", timestamp: `${ts}Z`, sessionId, content: "Prompt inicial para la prueba" },
  { type: "user", timestamp: `${ts}Z`, sessionId, cwd, message: { role: "user", content: "Prompt inicial para la prueba" } },
  {
    type: "assistant",
    timestamp: `${ts}Z`,
    sessionId,
    cwd,
    message: {
      role: "assistant",
      usage: { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 500, cache_creation_input_tokens: 10 },
    },
  },
  { type: "last-prompt", lastPrompt: "Prompt inicial para la prueba", sessionId },
  { type: "ai-title", aiTitle: "Título de la sesión", sessionId },
];

const freshIndex = (projectsDir, options = {}) =>
  createClaudeCodeSessionIndex({
    projectsDir,
    platform: "linux",
    liveMtimeMs: 120_000,
    ...options,
  });

describe("claude-code-sessions index", () => {
  it("indexes sessions with raw id, real cwd, title, timestamps, tokens and boolean live", async () => {
    const projectsDir = makeProjectsDir("basic");
    const projectDir = path.join(projectsDir, "-home-example-repo");
    fs.mkdirSync(projectDir);
    const sessionId = "11111111-2222-4333-8444-555555555555";
    writeJsonl(projectDir, sessionId, baseRecords(sessionId, "/home/example/repo", "2026-09-18T10:00:00"));

    const index = freshIndex(projectsDir);
    const result = await index.refresh();
    const sessions = index.listSessions();

    assert.equal(result.scanned, 1);
    assert.equal(sessions.length, 1);
    const session = sessions[0];
    assert.equal(session.id, sessionId);
    assert.equal(session.directory, "/home/example/repo");
    assert.equal(session.title, "Título de la sesión");
    assert.equal(session.time.updated, Date.parse("2026-09-18T10:00:00Z"));
    assert.equal(typeof session.time.created, "number");
    assert.equal(typeof session.live, "boolean");
    assert.deepEqual(session.tokens, {
      input: 120,
      output: 34,
      reasoning: 0,
      cache_read: 500,
      cache_creation: 10,
    });
    // Public entries must not leak cache bookkeeping.
    assert.equal("mtimeMs" in session, false);
    assert.equal("size" in session, false);
    index.stop();
  });

  it("falls back to the first prompt and then to the raw id for the title", async () => {
    const projectsDir = makeProjectsDir("titles");
    const projectDir = path.join(projectsDir, "-home-example-repo");
    fs.mkdirSync(projectDir);
    const promptId = "aaaaaaaa-0000-4000-8000-000000000001";
    const bareId = "aaaaaaaa-0000-4000-8000-000000000002";
    writeJsonl(projectDir, promptId, baseRecords(promptId, "/home/example/repo", "2026-09-18T10:00:00").filter((r) => r.type !== "ai-title"));
    writeJsonl(projectDir, bareId, [
      { type: "system", timestamp: "2026-09-18T11:00:00Z", sessionId: bareId, cwd: "/home/example/repo" },
    ]);

    const index = freshIndex(projectsDir);
    await index.refresh();
    const byId = new Map(index.listSessions().map((s) => [s.id, s]));
    assert.equal(byId.get(promptId).title, "Prompt inicial para la prueba");
    assert.equal(byId.get(bareId).title, bareId);
    index.stop();
  });

  it("does not read a >10 MB transcript whole (bounded head+tail bytes)", async () => {
    const projectsDir = makeProjectsDir("big");
    const projectDir = path.join(projectsDir, "-home-example-big");
    fs.mkdirSync(projectDir);
    const sessionId = "bbbbbbbb-0000-4000-8000-000000000001";
    const head = JSON.stringify({ type: "user", timestamp: "2026-09-01T00:00:00Z", sessionId, cwd: "/home/example/big", message: { role: "user", content: "arranque" } });
    const tail = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-18T23:00:00Z",
      sessionId,
      cwd: "/home/example/big",
      message: { role: "assistant", usage: { input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
    const aiTitle = JSON.stringify({ type: "ai-title", aiTitle: "Sesión grande", sessionId });
    // One ~12 MB record in the middle: never parsed, never loaded.
    const padding = "x".repeat(12 * 1024 * 1024);
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, [head, JSON.stringify({ type: "attachment", blob: padding, sessionId }), tail, aiTitle].join("\n") + "\n");
    assert.ok(fs.statSync(file).size > 10 * 1024 * 1024);

    let bytesRead = 0;
    const countingFs = {
      promises: {
        ...fs.promises,
        open: async (...args) => {
          const handle = await fs.promises.open(...args);
          return new Proxy(handle, {
            get(target, prop) {
              if (prop === "read") {
                return async (buffer, offset, length, position) => {
                  const result = await target.read(buffer, offset, length, position);
                  bytesRead += result.bytesRead;
                  return result;
                };
              }
              const value = target[prop];
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      },
    };

    const index = freshIndex(projectsDir, { fs: countingFs });
    await index.refresh();
    const [session] = index.listSessions();

    assert.ok(bytesRead < 1024 * 1024, `expected bounded reads, got ${bytesRead} bytes`);
    assert.equal(session.id, sessionId);
    assert.equal(session.directory, "/home/example/big");
    assert.equal(session.title, "Sesión grande");
    assert.equal(session.time.updated, Date.parse("2026-09-18T23:00:00Z"));
    assert.equal(session.tokens.input, 7);
    index.stop();
  });

  it("refreshes incrementally by mtime+size", async () => {
    const projectsDir = makeProjectsDir("incremental");
    const projectDir = path.join(projectsDir, "-home-example-inc");
    fs.mkdirSync(projectDir);
    const a = "cccccccc-0000-4000-8000-000000000001";
    const b = "cccccccc-0000-4000-8000-000000000002";
    const fileA = writeJsonl(projectDir, a, baseRecords(a, "/home/example/inc", "2026-09-18T10:00:00"));
    writeJsonl(projectDir, b, baseRecords(b, "/home/example/inc", "2026-09-18T09:00:00"));

    const index = freshIndex(projectsDir);
    const first = await index.refresh();
    assert.equal(first.reindexed, 2);

    const warm = await index.refresh();
    assert.equal(warm.reindexed, 0, "unchanged files must not be re-read");

    fs.appendFileSync(fileA, JSON.stringify({ type: "ai-title", aiTitle: "Título actualizado", sessionId: a }) + "\n");
    const third = await index.refresh();
    assert.equal(third.reindexed, 1);
    const byId = new Map(index.listSessions().map((s) => [s.id, s]));
    assert.equal(byId.get(a).title, "Título actualizado");

    fs.rmSync(fileA);
    const fourth = await index.refresh();
    assert.equal(fourth.scanned, 1);
    assert.equal(index.listSessions().length, 1);
    index.stop();
  });

  it("live is true only for freshly written or process-referenced sessions", async () => {
    const projectsDir = makeProjectsDir("live");
    const projectDir = path.join(projectsDir, "-home-example-live");
    fs.mkdirSync(projectDir);
    const fresh = "dddddddd-0000-4000-8000-000000000001";
    const stale = "dddddddd-0000-4000-8000-000000000002";
    writeJsonl(projectDir, fresh, baseRecords(fresh, "/home/example/live", "2026-09-18T10:00:00"));
    const staleFile = writeJsonl(projectDir, stale, baseRecords(stale, "/home/example/live", "2026-09-18T10:00:00"));
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(staleFile, old, old);

    const index = freshIndex(projectsDir, { liveMtimeMs: 120_000 });
    await index.refresh();
    const byId = new Map(index.listSessions().map((s) => [s.id, s]));
    assert.equal(byId.get(fresh).live, true);
    assert.equal(byId.get(stale).live, false);
    index.stop();
  });

  it("an empty or missing projects dir yields an empty index without throwing", async () => {
    const missing = path.join(tmpRoot, "does-not-exist");
    const index = freshIndex(missing);
    await index.refresh();
    assert.deepEqual(index.listSessions(), []);
    index.stop();
  });
});
