# Security Policy

## Trust model

Yui is designed for **one trusted local user** on their own machine. It is not
an OS sandbox and not a remote, multi-user service:

- Agents you configure run with your local privileges.
- The Web view (`yui web`) is loopback-only and read-only; browser access does
  not become Operator authority.
- Publishing, granting new access, and other external effects still require the
  corresponding authority.

Because of this model, "an Agent can run local actions you authorized" is
expected behavior, not a vulnerability.

## Supported versions

Yui is pre-1.0. Security fixes target the latest published release; please
upgrade before reporting if you can.

## Reporting a vulnerability

Please report anything security-sensitive **privately**, not in a public issue:

- Preferred: GitHub private vulnerability reporting — open the repository's
  **Security** tab and choose **Report a vulnerability**
  (<https://github.com/zhangqian-silk/yui/security/advisories/new>).
- Include a description, the affected version or commit, reproduction steps, and
  the impact you observed.

We will acknowledge your report, investigate, and coordinate a fix and
disclosure timeline with you. Thank you for helping keep Yui users safe.
