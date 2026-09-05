---
name: make-bot-ui
description: Build a UI that submits a constrained job to a user-provided webhook or supported Codex task integration.
---

# Make bot UI on Codex

The upstream routine API, secret-request card, and webhook wake event are Cursor services. Codex has no assumed drop-in equivalent. Preserve the UI-to-server-to-worker design, but inspect the actual integration before building it.

1. Identify the intended action and available backend. Use a user-provided webhook with a documented schema, or a supported Codex integration explicitly authorized for this task. Inspect its real API and authentication contract. If neither exists, build a local mock of the requested UI and state that live task dispatch needs a backend; do not invent a Codex webhook URL.
2. Keep the small JSON action schema explicit. Validate its fields at the server boundary. Treat action values as data, never shell commands or prompts granting arbitrary permissions.
3. Store credentials in the backend's secret store or local environment. Never put them in browser code, chat, committed files, logs, or screenshots. Use the host's supported secret flow when one exists; otherwise let the user configure the local secret out of band.
4. Let the browser call the local server. The server calls the verified backend with a finite timeout. Follow the backend's actual auth scheme. Do not claim delivery merely because the UI returned 200; verify the accepted job or harmless event at the receiving end. Retain failed requests for inspection without automatically replaying non-idempotent actions.
5. Bind to loopback for local use. If the user wants tailnet access, inspect the existing Tailscale node and its documented service exposure; obtain authorization before installing software or changing network exposure. Verify the real peer URL before sharing it.
6. Verify the UI, server validation, failure behavior, and receiving job independently. Report precisely which are live and which are mocked.
