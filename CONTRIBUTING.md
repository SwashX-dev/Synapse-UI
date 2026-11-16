# Contributing

Develop on main; retain upstream history and GPL attribution. Read docs/ARCHITECTURE.md and docs/BUILDING.md, use Node 24 or nix develop, then npm ci. Keep changes focused and explain the user-visible behavior and limitations.

Run lint, typecheck, unit tests and relevant Electron e2e tests before proposing code changes. Test native PTY changes on the affected OS. For graphics, dispose resources and include actual captures and measured results; do not invent screenshots or performance claims. Add behavior tests for meaningful fixes, not tests that mirror trivial implementation.

Document config/API changes and migration effects. New privileged operations need sender validation, argument validation and explicit capability boundaries. No credentials or private runtime data in commits. Report security issues privately as described in SECURITY.md.
