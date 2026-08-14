# OpenChamber Stream Metrics

Declarative UI contribution for OpenChamber. It adds a compact, host-rendered
metrics surface to the composer footer. The manifest contains data only and
cannot execute JavaScript in the renderer.

OpenChamber owns send acceptance, streaming events, metric calculation,
runtime/session isolation, rendering, tooltips, transport, and authentication.
Live output and speed are explicitly estimated; final output tokens and speed
use the authoritative assistant-message token counters when available.

Supported surfaces are Web, Electron Desktop, hosted mobile, and Capacitor
mobile. VS Code reports the contribution as `unsupported` and does not start
metric collection. Desktop connections to remote servers use the active
runtime's authenticated UI-extension catalog and streaming transport.

Users can enable or disable the extension per client under
Settings → Chat → UI extensions. It is enabled by default.
