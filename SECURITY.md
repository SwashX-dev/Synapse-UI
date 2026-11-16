# Security policy

SYNAPSE-UI 3.x alpha is the maintained development line; archived eDEX releases are not maintained here. See docs/SECURITY.md for the application trust model.

Please report suspected vulnerabilities through this repository's GitHub private vulnerability reporting / Security Advisories interface when available. If private reporting is unavailable, open a minimal issue requesting a private contact route without exploit details or secrets. Do not post terminal content, credentials or working remote-command exploits publicly.

Include affected version, platform, reproduction and impact. There is no guaranteed response SLA. The original CVE-2023-30856 terminal WebSocket transport is removed, with regression tests for no application-owned TCP listeners and renderer/IPC boundaries.
