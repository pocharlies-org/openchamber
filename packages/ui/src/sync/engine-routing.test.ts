import { afterEach, describe, expect, test } from "bun:test"
import { opencodeClient } from "@/lib/opencode/client"
import { EngineUnsupportedError } from "@/lib/sessionEngine"
import { useSkillsStore } from "@/stores/useSkillsStore"
import { routeCarriesKnowledge } from "./message-route"
import { routeMessage } from "./session-ui-store"

/**
 * The send path asks the session's engine how a message travels
 * (lib/sessionEngine.ts). These sessions are not synced, so the engine comes
 * from the id — `ses_ccc…` is a Claude Code session.
 */
const CLAUDE = "ses_ccc0b1e16d4-d15a-4616-b6d9-42db61f876f3"
const OPENCODE = "ses_fdbc3860bffehV4vp2SZOhrusN"

const original = {
  sendCommand: opencodeClient.sendCommand,
  shellSession: opencodeClient.shellSession,
  listCommands: opencodeClient.listCommands,
}
const calls: Array<{ method: string; args: unknown }> = []

const record = () => {
  calls.length = 0
  opencodeClient.sendCommand = (async (args: unknown) => { calls.push({ method: "sendCommand", args }) }) as typeof opencodeClient.sendCommand
  opencodeClient.shellSession = (async (args: unknown) => { calls.push({ method: "shellSession", args }); return "msg_shell" }) as typeof opencodeClient.shellSession
  opencodeClient.listCommands = (async (args: unknown) => { calls.push({ method: "listCommands", args }); return [] }) as typeof opencodeClient.listCommands
}

afterEach(() => {
  opencodeClient.sendCommand = original.sendCommand
  opencodeClient.shellSession = original.shellSession
  opencodeClient.listCommands = original.listCommands
})

const base = { providerID: "litellm-local", modelID: "qwen38-flash-next", directory: "/repo" }

describe("routeMessage by engine", () => {
  test("a Claude session sends every `/name args` as its own command, without asking OpenCode's list", async () => {
    record()
    const route = await routeMessage({ ...base, sessionId: CLAUDE, content: "/review src/app.ts" })
    expect(route).toBe("engine-command")
    expect(calls.map((call) => call.method)).toEqual(["sendCommand"])
    expect(calls[0].args).toMatchObject({ id: CLAUDE, command: "review", arguments: "src/app.ts", directory: "/repo" })
  })

  test("a Claude command carries the context attached to it, never the standing project knowledge", async () => {
    record()
    await routeMessage({
      ...base,
      sessionId: CLAUDE,
      content: "/review auth",
      additionalParts: [
        { text: "selected code", synthetic: true },
        { text: "project knowledge", synthetic: true, systemContext: "session-knowledge" },
      ],
    })
    expect(calls[0].args).toMatchObject({ command: "review", arguments: "auth", context: [{ text: "selected code" }] })
    expect(JSON.stringify(calls[0].args)).not.toContain("project knowledge")
  })

  test("prose that starts with a path is not a Claude command", async () => {
    record()
    await routeMessage({ ...base, sessionId: CLAUDE, content: "/usr/local/bin/node --version shows 18, why?" }).catch(() => undefined)
    expect(calls.some((call) => call.method === "sendCommand")).toBe(false)
  })

  test("the knowledge given to a send is recorded as delivered only on routes that carry it", () => {
    expect(routeCarriesKnowledge("prompt")).toBe(true)
    expect(routeCarriesKnowledge("command")).toBe(true)
    expect(routeCarriesKnowledge("engine-command")).toBe(false)
    expect(routeCarriesKnowledge("shell")).toBe(false)
  })

  test("a Claude session has no shell: refused before anything is sent", async () => {
    record()
    await expect(routeMessage({ ...base, sessionId: CLAUDE, content: "ls -la", inputMode: "shell" }))
      .rejects.toThrow(EngineUnsupportedError)
    expect(calls).toEqual([])
  })

  test("an OpenCode session keeps its shell", async () => {
    record()
    const route = await routeMessage({ ...base, sessionId: OPENCODE, content: "ls -la", inputMode: "shell" })
    expect(route).toBe("shell")
    expect(calls.map((call) => call.method)).toEqual(["shellSession"])
  })

  test("an OpenCode session still resolves an unknown `/name` against OpenCode's command list", async () => {
    record()
    const loadSkills = useSkillsStore.getState().loadSkills
    useSkillsStore.setState({ loadSkills: async () => true })
    await routeMessage({ ...base, sessionId: OPENCODE, content: "/project-command arg" }).catch(() => undefined)
    expect(calls.some((call) => call.method === "listCommands")).toBe(true)
    expect(calls.some((call) => call.method === "sendCommand")).toBe(false)
    useSkillsStore.setState({ loadSkills })
  })
})
