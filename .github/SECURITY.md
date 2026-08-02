# Security Policy

## Supported versions

| Version | Supported           |
| ------- | ------------------- |
| 2.x     | Yes                 |
| 1.x     | Security fixes only |
| < 1.0   | No                  |

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/GriffinCanCode/Retrigger/security/advisories/new).
Do not open a public issue; a public issue is a disclosure.

Please include the affected version and platform, the impact you believe it
has, and the smallest reproduction you can manage.

You should get an acknowledgement within 72 hours and an assessment within
seven days. If a fix is warranted it ships in a patch release, and the advisory
is published once the release is available. Credit is given unless you ask
otherwise.

## What is in scope

This project runs with the privileges of the process that starts it and reads
whatever it is pointed at, so the interesting surface is where untrusted input
crosses a boundary:

- **The C hash engine** (`src/core`). Memory safety is the whole game here:
  out-of-bounds reads or writes on adversarial input, and any divergence
  between the scalar, NEON, SSE2, AVX2, and AVX-512 paths. The paths are
  required to be bit-identical, and a difference between them is a bug worth
  reporting on its own.
- **Path handling.** Traversal outside a configured watch root, symlink
  following that escapes it, and TOCTOU between a change notification and the
  read that follows it.
- **The IPC surface** of the standalone daemon: unauthenticated access to the
  socket, or a message that crashes or hangs the daemon.
- **Install-time code execution** through the packages or their postinstall
  scripts.
- **Denial of service** that a watched directory can trigger against the
  watcher — unbounded memory from a pathological tree, or a wedge that stops
  events from being delivered.

## What is not in scope

- Resource exhaustion from deliberately pointing the watcher at an enormous
  tree with limits deliberately raised.
- Vulnerabilities in a dependency that already has a public advisory; those are
  handled by the `audit` CI job. Report them upstream.
- Findings that require an attacker to already have write access to the code
  being built, or to the machine running the watcher.
