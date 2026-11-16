# Security model

The legacy eDEX WebSocket terminal server is absent: there is no localhost shell-control listener. Main owns node-pty; validated IPC is accepted only from the trusted top-level window. The POSIX `synapse` helper emits OSC 7701 with a random per-session token; forged tokens are ignored. The token is not a boundary against commands already running as the same user in that terminal.

BrowserWindow uses sandbox, context isolation, no renderer Node, CSP and an application protocol with traversal checks. Navigation/new windows/webviews and unrelated permissions are blocked. Packaged Electron fuses disable RunAsNode, NODE_OPTIONS, inspector arguments and extra file privileges; ASAR-only loading/integrity is configured. The Nix package uses the shared nixpkgs Electron and does not modify its fuses.

Extensions require local import, explicit capability approval and enablement. Scripts additionally require a global opt-in and run in isolated frames without host APIs or network. Review scripts: a browser sandbox does not prevent expensive computation or misleading visuals. Built-ins and the application bundle are trusted code; the terminal intentionally executes user shell commands.

Production dependency auditing is part of CI (`npm run audit:deps`). Bundled frontend dependencies also deserve full `npm audit` during maintenance; production-only audit does not cover all renderer/build dependencies. No claim of a formal security audit is made. Follow SECURITY.md for private reporting.
