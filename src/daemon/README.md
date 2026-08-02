# @retrigger/daemon: One Shared File Watcher

[![npm version](https://img.shields.io/npm/v/@retrigger/daemon.svg)](https://www.npmjs.com/package/@retrigger/daemon)
[![downloads](https://img.shields.io/npm/dm/@retrigger/daemon.svg)](https://www.npmjs.com/package/@retrigger/daemon)
[![node](https://img.shields.io/node/v/@retrigger/daemon.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@retrigger/daemon.svg)](https://github.com/GriffinCanCode/Retrigger/blob/main/LICENSE)

One file watcher, shared by several processes, over a small HTTP API — a JSON
request/response surface, a server-sent event stream of changes, and Prometheus metrics,
all on one port.

Under the hood it is the same two crates `@retrigger/core` uses: `retrigger-system` for
watching (inotify on Linux, FSEvents on macOS, `ReadDirectoryChangesW` on Windows) and
`retrigger-core` for XXH3-64 content hashing with runtime SIMD dispatch.

## Contents

- [Who Should Not Be Here](#who-should-not-be-here)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Command Line](#command-line)
- [HTTP API](#http-api)
- [Configuration](#configuration)
- [Node.js API](#nodejs-api)
- [Performance](#performance)
- [Requirements](#requirements)
- [Troubleshooting](#troubleshooting)
- [Reporting a Problem](#reporting-a-problem)
- [License](#license)

## Who Should Not Be Here

This package is optional, and
[`@retrigger/core`](https://www.npmjs.com/package/@retrigger/core) watches in-process and
needs nothing from here.

Install the daemon only when more than one process must watch the same tree — a dev server
plus a test runner plus a type checker, say — and you would rather pay for one set of
kernel watches and one hash of each changed file than three.

## Installation

Installing globally puts the `retrigger` command on your path.

```bash
npm install -g @retrigger/daemon   # installs the `retrigger` command
```

The binary is downloaded as an optional platform package
(`@retrigger/daemon-darwin-arm64` and friends). If none matches your platform, nothing
here works and `@retrigger/core` should be used on its own.

## Quick Start

Write a configuration, name at least one root, check it, then run it.

```bash
retrigger config --output retrigger.toml   # write a default configuration
$EDITOR retrigger.toml                     # add at least one [[watcher.paths]]
retrigger validate --config retrigger.toml
retrigger start --config retrigger.toml
```

In another terminal, ask it what it is doing and stream from it.

```bash
retrigger status
curl -N localhost:9090/events    # stream changes as server-sent events
retrigger stop
```

## Command Line

Six commands make up the command line.

- **`retrigger start`** — runs the daemon in the foreground until stopped.
- **`retrigger stop`** — asks a running daemon to shut down, and waits until it has.
- **`retrigger status`** — prints what a running daemon is watching and how much it has
  done.
- **`retrigger validate`** — checks a configuration file without starting anything.
- **`retrigger config`** — writes a default configuration file.
- **`retrigger benchmark`** — measures hash throughput and watcher delivery on this
  machine.

Each one takes the flags shown here.

```
retrigger start   [-c <file>] [-f] [-d] [--bind <ip>] [-p <port>]
retrigger stop    [-c <file>] [--bind <ip>] [-p <port>] [-f]
retrigger status  [-c <file>] [--bind <ip>] [-p <port>] [--json]
retrigger validate [-c <file>]
retrigger config  [-o <file>] [--force]
retrigger benchmark [-d <dir>] [-f <files>] [-s <bytes>]
```

Two flags deserve a note, because their obvious reading is wrong.

- **`start --foreground`** — accepted, and does nothing. The daemon always runs in the
  foreground; backgrounding is a supervisor's job (systemd, launchd,
  `spawn(…, { detached: true })`), because a supervisor can restart it and capture its
  output and a self-daemonizing process cannot.
- **`stop --force`** — means "do not wait for it to finish", not SIGKILL. There is no
  signal to send: shutdown goes over the API, which is the same on every platform.

`stop` on a daemon that is not running succeeds and says so — scripts call it to reach a
state. `status` on one that is not running fails, because it was asked a question it cannot
answer.

## HTTP API

Everything the daemon exposes is on one port (`9090` by default, loopback only).

- **`GET /`** — lists the routes below.
- **`GET /health`** — returns `{"status":"ok","version":…,"watching":true}`, for
  supervisors and healthchecks.
- **`GET /status`** — returns everything `retrigger status --json` prints.
- **`GET /metrics`** — returns the same numbers in Prometheus exposition format.
- **`GET /events`** — returns a server-sent stream of processed events.
- **`POST /watch`** — takes `{"path": "/srv/app", "recursive": true}` and adds a root at
  runtime.
- **`POST /unwatch`** — takes `{"path": "/srv/app"}` and removes one, dropping its cached
  fingerprints.
- **`POST /shutdown`** — shuts down gracefully, and is what `retrigger stop` calls.

A path sent to `/watch` or `/unwatch` must be absolute and must name its target directly: a
`.` or `..` component earns a 400 rather than being resolved. This is a rule about how a
request is phrased, not a confinement boundary — any absolute path the daemon's user can read
is still watchable, so keep the bind address in mind. Roots configured in
`[[watcher.paths]]` are resolved relative to the working directory as before; the rule applies
only to what arrives over the network.

An event on `/events` looks like this.

```
event: change
data: {"event":{"path":"/srv/app/src/index.ts","kind":"Modified","timestamp_ns":1735…,
       "size":1041,"is_directory":false,"cookie":null},
       "hash":15266859121526765154,"content_changed":true,
       "processing_time_ns":52083,"cache_hit":false}
```

`content_changed` is the field worth acting on: it is `false` when a file was rewritten with
identical bytes, which formatters and build tools do constantly.

`hash` is the XXH3-64 digest of the file's contents, and is `null` for directories,
deletions, and files that could not be read.

Two other event types can arrive on the same stream.

- **`event: lagged`** — carries a count, and arrives when a subscriber fell further behind
  than the fan-out buffer.
- **`event: error`** — arrives when an event could not be serialized.

Both mean the same thing a `RescanRequired` event does: this stream is no longer a complete
description of the tree, so re-read whatever you care about.

### Authentication

There is no authentication, which is why the default bind address is `127.0.0.1`.

Anything that can reach this port can make the daemon watch any path the daemon's user can
read, and can read the change stream of everything it watches.

Binding `0.0.0.0` puts that on the network; do it only behind something that controls
access.

## Configuration

Every key the daemon reads is in the file `retrigger config` generates, and unknown keys
are rejected rather than ignored — so `retrigger validate` catches a typo instead of
silently using the default.

```toml
[server]
bind_address = "127.0.0.1"   # must be a literal IP; host names are refused
port = 9090                  # 0 asks the OS for an ephemeral port

[watcher]
queue_capacity = 4096        # overflow raises a rescan signal rather than losing changes silently
debounce_ms = 50             # leading-edge coalescing window; 0 disables it
follow_symlinks = true
hash_cache_size = 100000     # hard ceiling on cached content fingerprints
hash_cache_ttl_secs = 3600

[patterns]
include = []                 # empty means "no restriction"
exclude = ["**/node_modules/**", "**/.git/**", "**/target/**", "**/dist/**"]

[logging]
level = "info"               # error | warn | debug | trace; RUST_LOG overrides this
format = "compact"           # compact | pretty | json

# Nothing is watched until a root is declared.
[[watcher.paths]]
path = "/srv/app"
recursive = true
```

## Node.js API

A thin wrapper drives the same CLI.

```javascript
const { daemon } = require('@retrigger/daemon');

await daemon.start({ config: './retrigger.toml', foreground: true, debug: true });
console.log(await daemon.status());
await daemon.stop();
```

`start` spawns the binary and resolves once it has stayed up for a second, and `stop`
signals that child.

To talk to a daemon this process did not spawn, use the HTTP API directly — it is plain
JSON and needs no client library.

## Performance

Run `retrigger benchmark` rather than trusting a table: throughput depends on the SIMD
kernel that dispatches on your CPU, and event rates depend on the platform's watch backend,
which coalesces differently on each one.

The benchmark reports both, plus what was dropped.

## Requirements

The daemon has two requirements.

- **Node.js** — 18 or newer, for the wrapper; the binary itself has no runtime
  dependencies.
- **Operating system** — Linux, macOS, or Windows, on x64 or arm64.

## Troubleshooting

Four failures are documented here.

- **It will not start** — the most common cause is the port. `retrigger start --port 9091`,
  or find what holds it (`lsof -i :9090` on macOS and Linux). The daemon binds before it
  installs any watch, so a port conflict fails immediately and cheaply.
- **It watches nothing** — a configuration with no `[[watcher.paths]]` starts fine and does
  nothing, and `retrigger status` shows an empty watch list. Add a root, or `POST /watch`
  one at runtime.
- **Too many open files, or watch limit exceeded on Linux** — inotify needs one watch
  descriptor per directory. Exclude `node_modules` and friends — the generated
  configuration already does — or raise `fs.inotify.max_user_watches`.
- **Events arrive but nothing rebuilds** — check `content_changed`. If a tool rewrites
  files with identical contents, the daemon reports the event with
  `content_changed: false` on purpose.

## Reporting a Problem

Every package built from this tree is tracked in one place.

- **A bug** — open an issue on
  [the issue tracker](https://github.com/GriffinCanCode/Retrigger/issues).
- **A vulnerability** — follow
  [the security policy](https://github.com/GriffinCanCode/Retrigger/blob/main/.github/SECURITY.md),
  which reports privately rather than through the issue tracker.

## License

MIT
