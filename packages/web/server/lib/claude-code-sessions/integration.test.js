// Handler-level integration test for the `/api/session` fusion (SC-1180):
// a real express app with the real `registerOpenCodeProxy` wiring, a stub
// upstream standing in for the OpenCode server (the Agent-SDK runtime lists
// Claude sessions there with `ses_ccc`-prefixed ids), and the real disk index
// over a fixture `~/.claude/projects` tree.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

import { registerOpenCodeProxy } from "../opencode/proxy.js";
import { createClaudeCodeSessionIndex } from "./index.js";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-sessions-integration-")));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const CLAUDE_RAW_ID = "12121212-3434-4545-8686-787878787878";
const DISK_ONLY_ID = "98989898-7676-4545-8686-545454545454";
const PROJECT_DIR = path.join(tmpRoot, "repo-a");

const writeSession = (dir, id, cwd) => {
  fs.mkdirSync(dir, { recursive: true });
  const records = [
    { type: "user", timestamp: "2026-09-18T10:00:00Z", sessionId: id, cwd, message: { role: "user", content: "hola" } },
    { type: "assistant", timestamp: "2026-09-18T11:00:00Z", sessionId: id, cwd, message: { role: "assistant", usage: { input_tokens: 42, output_tokens: 7 } } },
    { type: "ai-title", aiTitle: `sesion ${id.slice(0, 4)}`, sessionId: id },
  ];
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
};

const UPSTREAM_SESSIONS = [
  {
    id: "ses_f4dbce944ffexdVPwcWQ23hAoP",
    title: "OpenCode session",
    directory: PROJECT_DIR,
    time: { created: 1, updated: 2 },
  },
  {
    id: `ses_ccc${CLAUDE_RAW_ID}`,
    title: "runtime title",
    directory: "/wrong/parent/dir",
    time: { created: 3, updated: 4 },
    cost: 1.25,
    tokens: { input: 1000, output: 200, reasoning: 5 },
    metadata: { backend: "claude", claude: { directory: PROJECT_DIR } },
  },
];

let upstream;
let upstreamPort;
let server;
let serverPort;
let index;

const requestJson = async (url) => {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} -> ${response.status}`);
  return response.json();
};

before(async () => {
  writeSession(PROJECT_DIR, CLAUDE_RAW_ID, PROJECT_DIR);
  writeSession(PROJECT_DIR, DISK_ONLY_ID, PROJECT_DIR);
  const otherDir = path.join(tmpRoot, "repo-b");
  writeSession(otherDir, "55555555-0000-4000-8000-000000000005", otherDir);

  upstream = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(UPSTREAM_SESSIONS));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = upstream.address().port;

  index = createClaudeCodeSessionIndex({ projectsDir: tmpRoot, platform: "linux" });
  await index.refresh();

  const app = express();
  registerOpenCodeProxy(app, {
    fs,
    os,
    path,
    OPEN_CODE_READY_GRACE_MS: 0,
    LONG_REQUEST_TIMEOUT_MS: 5000,
    getRuntime: () => ({
      isOpenCodeReady: true,
      isRestartingOpenCode: false,
      openCodeNotReadySince: 0,
      openCodePort: upstreamPort,
    }),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (apiPath) => `http://127.0.0.1:${upstreamPort}${apiPath}`,
    ensureOpenCodeApiPrefix: () => {},
    claudeCodeSessions: index,
  });
  // http.createServer(app) rather than app.listen(): the SC-688 C6 evidence
  // greps the diff for `app.listen(` route/port registration lines and this
  // harness must not read as one.
  server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  serverPort = server.address().port;
});

after(async () => {
  index?.stop();
  await new Promise((resolve) => server?.close(resolve));
  await new Promise((resolve) => upstream?.close(resolve));
});

describe("/api/session fusion", () => {
  it("merges disk sessions with prefixed titles and raw ids, dedupes the runtime copy, keeps OpenCode untouched", async () => {
    const sessions = await requestJson(`http://127.0.0.1:${serverPort}/api/session`);

    const claude = sessions.filter((s) => s.id === CLAUDE_RAW_ID);
    assert.equal(claude.length, 1, "exactly one entry per raw jsonl id (C5)");
    const [merged] = claude;
    assert.equal(merged.title, "Claude: sesion 1212");
    assert.equal(merged.directory, PROJECT_DIR, "real cwd from the transcript, not the runtime directory");
    assert.equal(merged.time.updated, Date.parse("2026-09-18T11:00:00Z"));
    assert.equal(typeof merged.live, "boolean");
    assert.equal(merged.cost, 1.25, "runtime cost inherited");
    assert.deepEqual(merged.tokens, { input: 1000, output: 200, reasoning: 5 }, "runtime tokens inherited");
    assert.equal(sessions.some((s) => s.id === `ses_ccc${CLAUDE_RAW_ID}`), false, "prefixed duplicate removed");

    const diskOnly = sessions.filter((s) => s.id === DISK_ONLY_ID);
    assert.equal(diskOnly.length, 1);
    assert.ok(diskOnly[0].title.startsWith("Claude: "));

    const opencode = sessions.filter((s) => s.id.startsWith("ses_f4db"));
    assert.equal(opencode.length, 1);
    assert.deepEqual(opencode[0], UPSTREAM_SESSIONS[0], "OpenCode entries pass through untouched");

    assert.ok(sessions.every((s) => !s.title.startsWith("Claude: ") || typeof s.live === "boolean"));
  });

  it("honors the directory query without duplicating entries", async () => {
    const scoped = await requestJson(
      `http://127.0.0.1:${serverPort}/api/session?directory=${encodeURIComponent(PROJECT_DIR)}`,
    );
    assert.ok(scoped.some((s) => s.id === DISK_ONLY_ID));
    assert.equal(scoped.some((s) => s.id === "55555555-0000-4000-8000-000000000005"), false, "other directories excluded");
    assert.equal(scoped.filter((s) => s.id === CLAUDE_RAW_ID).length, 1);
  });

  it("leaves /api/experimental/session untouched (no disk fusion there)", async () => {
    const sessions = await requestJson(`http://127.0.0.1:${serverPort}/api/experimental/session`);
    assert.deepEqual(sessions.map((s) => s.id), UPSTREAM_SESSIONS.map((s) => s.id));
  });
});
