# OpenChamber Side Chat

Declarative UI contribution for OpenChamber Web and Desktop. It adds `/btw`,
`/side`, and a composer button. OpenChamber owns all session, transport,
authentication, and deletion operations; this package never executes code in
the renderer.

OpenChamber Web publishes the packaged declarative contract through its
authenticated UI-extension catalog. Desktop reuses that server and shared UI.
Users can enable or disable the extension under Settings → Chat; the preference
is local to that client.

The host forks at the last completed assistant message so a running parent turn
continues independently. Side chats are not nestable. Empty side chats are
discarded on close; non-empty chats ask whether to discard or keep the child
session.
