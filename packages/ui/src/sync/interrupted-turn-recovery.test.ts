import { afterEach, describe, expect, test } from "bun:test"
import type { MessagePage } from "@/lib/opencode/client"
import type { Message, Part } from "@/lib/opencode/model"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader, setImperativeSessionMessageLoader } from "./session-message-loader"
import { recoverInterruptedTurnAfterMessageLoad } from "./sync-context"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

const user: Message = { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 1 } }
const openAssistant: Message = {
  id: "msg_a", sessionID: "ses_1", role: "assistant", time: { created: 2 },
  modelID: "m", providerID: "p", agent: "build",
}
const text: Part = { id: "prt_a", messageID: "msg_a", sessionID: "ses_1", type: "text", text: "4" }

function setup(serverRecords: () => Array<{ info: Message; parts: Part[] }>) {
  const childStores = new ChildStoreManager()
  const store = childStores.ensureChild("/repo", { bootstrap: false })
  store.setState({
    session: [],
    message: { ses_1: [user, openAssistant] },
    part: { msg_a: [text] },
    session_status: { ses_1: { type: "idle" } },
  })
  let reads = 0
  const sdk = {
    getSessionMessages: async (): Promise<MessagePage> => {
      reads += 1
      return { items: serverRecords(), cursor: {} }
    },
  }
  const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "recovery-test" })
  setImperativeSessionMessageLoader(loader)
  cleanups.push(() => { setImperativeSessionMessageLoader(null); childStores.disposeAll() })
  return { store, reads: () => reads }
}

describe("recoverInterruptedTurnAfterMessageLoad", () => {
  test("re-reads the tail under an idle status before calling the turn interrupted", async () => {
    // The messages were read while the turn was still running; the status was
    // read after it finished. The server now has the completed message.
    const completed: Message = { ...openAssistant, time: { created: 2, completed: 3 }, finish: "stop" }
    const { store, reads } = setup(() => [{ info: user, parts: [] }, { info: completed, parts: [text] }])

    await recoverInterruptedTurnAfterMessageLoad("/repo", store, "ses_1")

    expect(reads()).toBe(1)
    const assistant = store.getState().message.ses_1.find((message) => message.id === "msg_a")
    expect(assistant).toMatchObject({ time: { completed: 3 }, finish: "stop" })
    expect(assistant !== undefined && "error" in assistant).toBe(false)
  })

  test("marks the turn interrupted when the settled server still has it open", async () => {
    const { store, reads } = setup(() => [{ info: user, parts: [] }, { info: openAssistant, parts: [text] }])

    await recoverInterruptedTurnAfterMessageLoad("/repo", store, "ses_1")

    expect(reads()).toBe(1)
    const assistant = store.getState().message.ses_1.find((message) => message.id === "msg_a")
    expect(assistant).toMatchObject({ error: { type: "aborted" } })
    expect(assistant?.role === "assistant" && assistant.time.completed !== undefined).toBe(true)
  })
})

describe("recoverInterruptedTurnAfterMessageLoad — a Claude Code session", () => {
  // The Claude engine streams an answer live as `msg_<API message id>` and,
  // since the transcript read files it under that same id, the two copies are
  // one record: the read replaces the live one instead of sitting beside it.
  const liveId = "msg_msg_011CfUvoo"
  const liveAnswer: Message = {
    id: liveId, sessionID: "ses_1", role: "assistant", time: { created: 2 },
    modelID: "qwen38-flash-next", providerID: "claude", agent: "claude",
  }
  const liveReasoning: Part = { id: "prt_r", messageID: liveId, sessionID: "ses_1", type: "reasoning", text: "thinking", time: { start: 2 } }

  test("the transcript copy under the live id settles the answer: one copy, not interrupted", async () => {
    const childStores = new ChildStoreManager()
    const store = childStores.ensureChild("/repo", { bootstrap: false })
    store.setState({
      session: [],
      message: { ses_1: [user, liveAnswer] },
      part: { [liveId]: [liveReasoning] },
      session_status: { ses_1: { type: "idle" } },
    })
    const fromTranscript: Message = { ...liveAnswer, time: { created: 2, completed: 5 }, finish: "stop" }
    const sdk = {
      getSessionMessages: async (): Promise<MessagePage> => ({
        items: [{ info: user, parts: [] }, { info: fromTranscript, parts: [liveReasoning] }],
        cursor: {},
      }),
    }
    const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "recovery-claude-test" })
    setImperativeSessionMessageLoader(loader)
    cleanups.push(() => { setImperativeSessionMessageLoader(null); childStores.disposeAll() })

    await recoverInterruptedTurnAfterMessageLoad("/repo", store, "ses_1")

    const answers = store.getState().message.ses_1.filter((message) => message.role === "assistant")
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatchObject({ id: liveId, time: { completed: 5 }, finish: "stop" })
    expect("error" in answers[0]).toBe(false)
    expect(store.getState().part[liveId]).toHaveLength(1)
  })
})
