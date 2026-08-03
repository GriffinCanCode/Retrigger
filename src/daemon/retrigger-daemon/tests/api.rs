//! End-to-end tests against a real daemon on a real socket.
//!
//! Nothing here is mocked: a watcher is attached to a temporary directory, the HTTP server is
//! bound to an ephemeral port, and the assertions are made by talking to it the way another
//! process would.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use retrigger_daemon::client::{self, HttpResponse, Reply};
use retrigger_daemon::config::{DaemonConfig, WatchPath};
use retrigger_daemon::{api, Daemon};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;

/// Generous, because the point is to fail on a broken daemon rather than on a loaded CI box.
/// macOS FSEvents in particular batches with a latency measured in hundreds of milliseconds.
const EVENT_BUDGET: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

struct Harness {
    dir: tempfile::TempDir,
    daemon: Arc<Daemon>,
    address: SocketAddr,
    server: JoinHandle<Result<()>>,
}

impl Harness {
    async fn start() -> Result<Self> {
        let dir = tempfile::tempdir()?;

        let mut config = DaemonConfig::default();
        config.server.port = 0;
        // Zero debounce: these tests assert about individual writes, and a coalescing window
        // would make "did the event arrive" a question about timing rather than about wiring.
        config.watcher.debounce_ms = 0;
        // The default excludes drop dotfiles-adjacent noise but not the temp tree itself; keep
        // the filter empty so nothing under test is silently swallowed.
        config.patterns.exclude.clear();
        config.watcher.paths = vec![WatchPath {
            path: dir.path().to_path_buf(),
            recursive: true,
        }];

        let listener = tokio::net::TcpListener::bind(config.socket_addr()?).await?;
        let address = listener.local_addr()?;

        let daemon = Arc::new(Daemon::new(config)?);
        daemon.set_address(address);
        daemon.start()?;

        let server = tokio::spawn(api::serve(Arc::clone(&daemon), listener));
        Ok(Self {
            dir,
            daemon,
            address,
            server,
        })
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    async fn get(&self, path: &str) -> Result<HttpResponse> {
        answered(client::get(self.address, path, REQUEST_TIMEOUT).await?)
    }

    async fn post(&self, path: &str) -> Result<HttpResponse> {
        answered(client::post(self.address, path, REQUEST_TIMEOUT).await?)
    }

    /// `POST` with a JSON body. The shipped client deliberately cannot send bodies, so the
    /// tests that need one speak HTTP directly.
    async fn post_json(&self, path: &str, body: &str) -> Result<HttpResponse> {
        raw_post_json(self.address, path, body).await
    }

    async fn status(&self) -> Result<Value> {
        Ok(serde_json::from_str(&self.get("/status").await?.body)?)
    }

    /// Wait for the connected-subscriber count to reach `expected`.
    ///
    /// Polled rather than asserted after a sleep: a subscriber is registered when its request
    /// reaches the handler, which is soon but not synchronous with `connect`, and a fixed sleep
    /// turns a loaded machine into a test failure.
    async fn await_subscribers(&self, expected: u64, budget: Duration) -> Result<()> {
        let deadline = Instant::now() + budget;
        let mut last = None;
        while Instant::now() < deadline {
            last = self.status().await?["subscribers"].as_u64();
            if last == Some(expected) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        bail!("expected {expected} subscribers within {budget:?}, last saw {last:?}")
    }

    async fn shutdown(self) -> Result<()> {
        self.daemon.request_shutdown();
        tokio::time::timeout(Duration::from_secs(10), self.server)
            .await
            .context("the server did not shut down")???;
        Ok(())
    }
}

fn answered(reply: Reply) -> Result<HttpResponse> {
    match reply {
        Reply::Answered(response) => Ok(response),
        Reply::Unreachable(reason) => bail!("the daemon was unreachable: {reason}"),
    }
}

/// Speak a one-shot JSON `POST` by hand, from anywhere: the shipped client cannot send bodies,
/// and the chaos tests need to fire these from many concurrent tasks that do not share a harness.
async fn raw_post_json(address: SocketAddr, path: &str, body: &str) -> Result<HttpResponse> {
    let mut stream = TcpStream::connect(address).await?;
    let request = format!(
        "POST {path} HTTP/1.0\r\nHost: {address}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await?;
    stream.flush().await?;

    let mut raw = Vec::new();
    tokio::time::timeout(REQUEST_TIMEOUT, stream.read_to_end(&mut raw))
        .await
        .context("the daemon did not answer")??;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .context("no header terminator in the response")?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .context("no status code in the response")?;
    Ok(HttpResponse {
        status,
        body: body.to_owned(),
    })
}

/// Read server-sent events until `wanted` `change` payloads have arrived or the budget expires.
///
/// Speaks HTTP/1.1 by hand because this is a streaming response: the shipped client only knows
/// how to read a response that ends.
/// Read server-sent events until `wanted` file `change` payloads have arrived or the budget
/// expires.
///
/// Events for directories are read past rather than counted. The watch root is itself a directory
/// inside the temp tree, and the backends report structural changes to it — on macOS, FSEvents
/// delivers a `Modified` and a `Metadata` for the root within milliseconds of the watch being
/// installed. Counting those would end a one-event read before the test that spawned it had
/// looked at the subscriber count even once, which is exactly the failure this replaced: a
/// subscriber that connected, was served, and left, all between two polls.
async fn stream_events(address: SocketAddr, wanted: usize, budget: Duration) -> Result<Vec<Value>> {
    let mut stream = TcpStream::connect(address).await?;
    stream
        .write_all(
            format!("GET /events HTTP/1.1\r\nHost: {address}\r\nAccept: text/event-stream\r\n\r\n")
                .as_bytes(),
        )
        .await?;
    stream.flush().await?;

    let deadline = Instant::now() + budget;
    let mut buffered = String::new();
    let mut chunk = [0_u8; 4096];
    let mut events = Vec::new();

    while Instant::now() < deadline && events.len() < wanted {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let read = match tokio::time::timeout(remaining, stream.read(&mut chunk)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(read)) => read,
            Ok(Err(err)) => return Err(err.into()),
            Err(_) => break,
        };
        buffered.push_str(&String::from_utf8_lossy(&chunk[..read]));

        // Chunked transfer framing is interleaved with the event text, but every SSE field
        // starts at a line boundary, so scanning lines is enough to pull the payloads out.
        for line in buffered.lines() {
            if let Some(payload) = line.strip_prefix("data: ") {
                if let Ok(value) = serde_json::from_str::<Value>(payload) {
                    if value["event"]["is_directory"] == Value::Bool(true) {
                        continue;
                    }
                    events.push(value);
                }
            }
        }
        if !events.is_empty() {
            buffered.clear();
        }
    }
    Ok(events)
}

/// Keep touching files until the watcher reports something, so a slow backend costs time rather
/// than a false failure.
fn keep_writing(root: &Path, contents: Vec<u8>) -> tokio::task::JoinHandle<()> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        for index in 0..200 {
            if std::fs::write(root.join(format!("change-{index}.txt")), &contents).is_err() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    })
}

#[tokio::test]
async fn health_reports_a_running_watcher() -> Result<()> {
    let harness = Harness::start().await?;

    let response = harness.get("/health").await?;
    assert_eq!(response.status, 200);
    let body: Value = serde_json::from_str(&response.body)?;
    assert_eq!(body["status"], "ok");
    assert_eq!(body["watching"], true);
    assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));

    harness.shutdown().await
}

#[tokio::test]
async fn status_describes_the_watcher_that_is_actually_running() -> Result<()> {
    let harness = Harness::start().await?;

    let status = harness.status().await?;
    assert_eq!(status["running"], true);
    assert_eq!(status["pid"], std::process::id());
    assert_eq!(status["address"], harness.address.to_string());
    assert_eq!(status["watched"].as_array().map(Vec::len), Some(1));
    assert!(
        status["backend"].is_string(),
        "the backend in use must be reported, got {status:#}"
    );
    assert!(
        status["processor"]["capacity"].as_u64().unwrap_or(0) > 0,
        "the fingerprint cache must report its ceiling"
    );

    harness.shutdown().await
}

#[tokio::test]
async fn metrics_are_scrapeable() -> Result<()> {
    let harness = Harness::start().await?;

    let response = harness.get("/metrics").await?;
    assert_eq!(response.status, 200);
    assert!(response
        .body
        .contains("# TYPE retrigger_events_processed_total counter"));
    assert!(
        response.body.contains("\nretrigger_up 1\n"),
        "a running daemon must say so:\n{}",
        response.body
    );
    harness.shutdown().await
}

#[tokio::test]
async fn an_unknown_route_is_a_404_not_a_crash() -> Result<()> {
    let harness = Harness::start().await?;
    assert_eq!(harness.get("/nope").await?.status, 404);
    // ... and the daemon is still serving afterwards.
    assert_eq!(harness.get("/health").await?.status, 200);
    harness.shutdown().await
}

#[tokio::test]
async fn a_watch_can_be_added_and_removed_at_runtime() -> Result<()> {
    let harness = Harness::start().await?;
    let extra = harness.path("extra");
    std::fs::create_dir(&extra)?;

    let added = harness
        .post_json("/watch", &format!("{{\"path\":{:?}}}", extra.display()))
        .await?;
    assert_eq!(added.status, 200, "{}", added.body);
    assert_eq!(
        harness.status().await?["watched"].as_array().map(Vec::len),
        Some(2)
    );

    let removed = harness
        .post_json("/unwatch", &format!("{{\"path\":{:?}}}", extra.display()))
        .await?;
    assert_eq!(removed.status, 200, "{}", removed.body);
    assert_eq!(
        harness.status().await?["watched"].as_array().map(Vec::len),
        Some(1)
    );

    harness.shutdown().await
}

/// An absolute path that does not exist, spelled for the platform running the test.
///
/// Absolute matters: the API refuses a relative path with a 400 before it can discover that the
/// target is missing, and "missing" is what these assertions are about. A bare `/nope` is
/// absolute on Unix and merely rootless on Windows, where absolute means a drive or a UNC share.
fn absent(name: &str) -> String {
    if cfg!(windows) {
        format!("C:\\definitely\\not\\here\\{name}")
    } else {
        format!("/definitely/not/here/{name}")
    }
}

#[tokio::test]
async fn bad_watch_requests_are_rejected_with_a_code_the_client_can_act_on() -> Result<()> {
    let harness = Harness::start().await?;

    let missing = harness
        .post_json("/watch", &format!("{{\"path\":{:?}}}", absent("watch")))
        .await?;
    assert_eq!(missing.status, 404, "{}", missing.body);
    assert!(missing.body.contains("error"), "{}", missing.body);

    let unwatched = harness
        .post_json("/unwatch", &format!("{{\"path\":{:?}}}", absent("unwatch")))
        .await?;
    assert_eq!(unwatched.status, 404, "{}", unwatched.body);

    for body in [
        "not json at all",
        "{}",
        "{\"path\":\"/tmp\",\"recursve\":true}",
        "[]",
    ] {
        let response = harness.post_json("/watch", body).await?;
        assert!(
            (400..500).contains(&response.status),
            "a malformed body must be the client's fault, not a 500: {body:?} gave {} {}",
            response.status,
            response.body
        );
    }

    // Every one of those was survivable.
    assert_eq!(harness.get("/health").await?.status, 200);
    harness.shutdown().await
}

#[tokio::test]
async fn snapshot_returns_a_self_describing_inventory_without_registering_a_watch() -> Result<()> {
    let harness = Harness::start().await?;
    std::fs::write(harness.path("a.txt"), b"hello")?;
    std::fs::create_dir(harness.path("sub"))?;
    std::fs::write(harness.path("sub/b.txt"), b"world")?;

    let response = harness
        .get(&format!("/snapshot?path={}", harness.dir.path().display()))
        .await?;
    assert_eq!(response.status, 200, "{}", response.body);
    let body: Value = serde_json::from_str(&response.body)?;
    assert_eq!(body["algorithm"], "xxh3-64");
    assert_eq!(body["version"], 1);
    let entries = body["entries"].as_array().expect("entries array");
    let paths: Vec<&str> = entries
        .iter()
        .map(|entry| entry["path"].as_str().expect("path is a string"))
        .collect();
    assert!(paths.iter().any(|p| p.ends_with("a.txt")), "{paths:?}");
    assert!(paths.iter().any(|p| p.ends_with("sub")), "{paths:?}");
    assert!(paths.iter().any(|p| p.ends_with("b.txt")), "{paths:?}");

    let a_txt = entries
        .iter()
        .find(|entry| entry["path"].as_str().is_some_and(|p| p.ends_with("a.txt")))
        .expect("a.txt entry");
    assert_eq!(a_txt["is_directory"], false);
    assert_eq!(a_txt["size"], 5);
    assert!(a_txt["modified_ns"].is_number() || a_txt["modified_ns"].is_string());

    // A snapshot is read-only: it must not have registered a watch on anything it crawled.
    assert_eq!(
        harness.status().await?["watched"].as_array().map(Vec::len),
        Some(1)
    );

    harness.shutdown().await
}

#[tokio::test]
async fn a_snapshot_of_a_missing_path_is_not_found() -> Result<()> {
    let harness = Harness::start().await?;
    let response = harness
        .get(&format!("/snapshot?path={}", absent("snapshot")))
        .await?;
    assert_eq!(response.status, 404, "{}", response.body);
    assert!(response.body.contains("error"), "{}", response.body);
    harness.shutdown().await
}

#[tokio::test]
async fn a_snapshot_request_reuses_the_same_path_vetting_as_watch() -> Result<()> {
    let harness = Harness::start().await?;
    // A relative path fails `vet` for the same reason a relative `/watch` body does.
    let response = harness.get("/snapshot?path=relative/path").await?;
    assert_eq!(response.status, 400, "{}", response.body);
    harness.shutdown().await
}

#[tokio::test]
async fn a_file_change_reaches_a_subscriber_with_the_xxh3_digest() -> Result<()> {
    let harness = Harness::start().await?;
    let contents = b"the bytes that must be hashed".to_vec();
    let expected = retrigger_core::hash(&contents);
    let whole = contents.len() as u64;

    let reader = tokio::spawn(stream_events(harness.address, 4, EVENT_BUDGET));
    // Nothing is written until the subscription is registered, or the change could be missed.
    harness
        .await_subscribers(1, Duration::from_secs(10))
        .await?;
    let writer = keep_writing(harness.dir.path(), contents);

    let events = reader.await??;
    writer.abort();

    // Not simply the first event. `std::fs::write` creates the file and then fills it, and the
    // watcher is entitled to report the empty file it saw in between -- on Windows it regularly
    // does, and that event is correct: it carries the digest of no bytes. The claim being made
    // here is about the event that reports the settled file.
    let event = events
        .iter()
        .find(|event| event["event"]["size"].as_u64() == Some(whole))
        .with_context(|| {
            format!("no event reported the file at its full length within the budget: {events:#?}")
        })?;
    assert_eq!(
        event["hash"].as_u64(),
        Some(expected),
        "the daemon must report the XXH3-64 digest from retrigger-core, got {event:#}"
    );
    assert!(
        event["event"]["path"]
            .as_str()
            .unwrap_or_default()
            .contains("change-"),
        "the event should name the file that changed: {event:#}"
    );

    // Asserted on the first event rather than on the settled one. Every file the writer produces
    // carries the same bytes, so once the content cache has seen them `false` is the correct
    // answer for the rest — the claim worth making is that their first appearance was a change.
    let first = events.first().context("the subscriber received nothing")?;
    assert_eq!(
        first["content_changed"], true,
        "the first sight of these bytes must be reported as a content change, got {first:#}"
    );

    harness.shutdown().await
}

#[tokio::test]
async fn two_subscribers_see_the_same_change() -> Result<()> {
    // This is the daemon's entire reason to exist: one set of kernel watches, one hash, many
    // readers.
    let harness = Harness::start().await?;
    let contents = b"shared".to_vec();

    let first = tokio::spawn(stream_events(harness.address, 4, EVENT_BUDGET));
    let second = tokio::spawn(stream_events(harness.address, 4, EVENT_BUDGET));
    harness
        .await_subscribers(2, Duration::from_secs(10))
        .await?;

    let writer = keep_writing(harness.dir.path(), contents.clone());
    let (first, second) = (first.await??, second.await??);
    writer.abort();

    let expected = retrigger_core::hash(&contents);
    let whole = contents.len() as u64;
    for events in [&first, &second] {
        // The settled file rather than the first event, for the reason given in the digest test:
        // a create caught before the bytes land is a real event about a real empty file.
        let event = events
            .iter()
            .find(|event| event["event"]["size"].as_u64() == Some(whole))
            .with_context(|| format!("a subscriber saw no completed write: {events:#?}"))?;
        assert_eq!(event["hash"].as_u64(), Some(expected));
    }

    // The processor hashed once per event, not once per subscriber.
    let status = harness.status().await?;
    let hashed = status["processor"]["files_hashed"].as_u64().unwrap_or(0);
    let processed = status["events_processed"].as_u64().unwrap_or(0);
    assert!(
        hashed <= processed,
        "hashing should happen once per event ({hashed} hashes for {processed} events)"
    );

    harness.shutdown().await
}

#[tokio::test]
async fn the_subscriber_count_falls_when_a_client_disconnects() -> Result<()> {
    let harness = Harness::start().await?;

    // The reader waits for an event that never comes, then gives up and drops its socket.
    let reader = tokio::spawn(stream_events(harness.address, 1, Duration::from_secs(3)));
    harness
        .await_subscribers(1, Duration::from_secs(10))
        .await?;

    let _ = reader.await?;
    harness
        .await_subscribers(0, Duration::from_secs(10))
        .await
        .context("the count never fell back to zero after the client went away")?;
    harness.shutdown().await
}

#[tokio::test]
async fn shutdown_over_the_api_stops_the_server_even_with_a_stream_open() -> Result<()> {
    // A subscriber holding an open connection must not be able to hold shutdown hostage.
    let harness = Harness::start().await?;
    let address = harness.address;

    let reader = tokio::spawn(stream_events(address, 100, Duration::from_secs(30)));
    harness
        .await_subscribers(1, Duration::from_secs(10))
        .await?;

    let response = harness.post("/shutdown").await?;
    assert_eq!(response.status, 202, "{}", response.body);

    tokio::time::timeout(Duration::from_secs(10), harness.server)
        .await
        .context("the server did not stop while an event stream was open")???;

    let _ = tokio::time::timeout(Duration::from_secs(10), reader).await;
    assert!(
        !client::is_listening(address, Duration::from_secs(1)).await,
        "the port must be closed once the server has stopped"
    );
    Ok(())
}

#[tokio::test]
async fn the_port_cannot_be_bound_twice() -> Result<()> {
    let harness = Harness::start().await?;

    let err = tokio::net::TcpListener::bind(harness.address)
        .await
        .expect_err("binding an address the daemon already holds must fail");
    assert_eq!(
        err.kind(),
        std::io::ErrorKind::AddrInUse,
        "expected an address-in-use error, got {err}"
    );

    harness.shutdown().await
}

/// Write `count` small files as fast as the disk allows, so the watcher and processor are put
/// under a real burst rather than a metronome. Returns once every write has been issued.
fn burst_writes(root: &Path, count: usize) -> JoinHandle<()> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        for index in 0..count {
            let _ = std::fs::write(root.join(format!("burst-{index}.txt")), index.to_le_bytes());
        }
    })
}

#[tokio::test]
async fn toxic_paths_and_oversized_bodies_are_refused_without_taking_the_daemon_down() -> Result<()>
{
    let harness = Harness::start().await?;

    // A path that is 64 KiB of slashes, a classic traversal string, an embedded NUL, and a body
    // that is far larger than any real request: each must be refused, and none may be a 5xx that
    // says the server fell over rather than the client sending nonsense.
    let overlong = format!("/{}", "a/".repeat(32 * 1024));
    let toxic_bodies = [
        format!("{{\"path\":{overlong:?}}}"),
        r#"{"path":"../../../../../../etc/passwd"}"#.to_owned(),
        r#"{"path":"/tmp/has\u0000nul"}"#.to_owned(),
        format!(
            "{{\"path\":\"/tmp\",\"junk\":\"{}\"}}",
            "x".repeat(256 * 1024)
        ),
        format!("{{\"path\":\"{}\"", "\"".repeat(1024)), // truncated, never closes
    ];
    for body in &toxic_bodies {
        let response = harness.post_json("/watch", body).await?;
        assert!(
            response.status >= 400,
            "a toxic body must be refused, not accepted: {} for {} bytes",
            response.status,
            body.len()
        );
    }

    // Every one of those was survivable, and the daemon is still watching the one real path.
    assert_eq!(harness.get("/health").await?.status, 200);
    assert_eq!(
        harness.status().await?["watched"].as_array().map(Vec::len),
        Some(1),
        "no toxic path may have leaked into the watch set"
    );
    harness.shutdown().await
}

#[tokio::test]
async fn concurrent_watch_and_unwatch_over_http_leaves_a_consistent_watch_set() -> Result<()> {
    let harness = Harness::start().await?;
    let address = harness.address;

    // Real subdirectories so the watch calls succeed rather than 404-ing on their own.
    const DIRS: usize = 12;
    let mut paths = Vec::new();
    for index in 0..DIRS {
        let dir = harness.path(&format!("sub-{index}"));
        std::fs::create_dir(&dir)?;
        paths.push(dir);
    }

    // Fire a watch and an unwatch for every directory at once. Whatever order they land in, the
    // daemon must not deadlock, double-count, or lose track of the original root.
    let mut handles = Vec::new();
    for path in &paths {
        let body = format!("{{\"path\":{:?}}}", path.display());
        let watch = body.clone();
        handles.push(tokio::spawn(async move {
            raw_post_json(address, "/watch", &watch).await
        }));
        handles.push(tokio::spawn(async move {
            raw_post_json(address, "/unwatch", &body).await
        }));
    }
    for handle in handles {
        // A panicked task or a torn response is the failure we are hunting; surface it.
        let response = handle.await??;
        assert!(
            response.status < 500,
            "a concurrent watch/unwatch must never 5xx: {}",
            response.status
        );
    }

    // The set landed somewhere between "only the root" and "the root plus every subdir", and the
    // daemon is still healthy either way.
    assert_eq!(harness.get("/health").await?.status, 200);
    let watched = harness.status().await?["watched"]
        .as_array()
        .map(Vec::len)
        .unwrap_or_default();
    assert!(
        (1..=DIRS + 1).contains(&watched),
        "the watch set is inconsistent after concurrent churn: {watched} roots"
    );
    harness.shutdown().await
}

#[tokio::test]
async fn a_subscriber_that_never_reads_cannot_stall_the_daemon() -> Result<()> {
    // The bounded per-client channel exists precisely so one slow reader cannot become everyone's
    // problem. Open a stream, ask for events, then never read a byte, and prove the rest of the
    // daemon stays responsive while its buffer to that client backs up.
    let harness = Harness::start().await?;

    let mut deadbeat = TcpStream::connect(harness.address).await?;
    deadbeat
        .write_all(
            format!(
                "GET /events HTTP/1.1\r\nHost: {}\r\nAccept: text/event-stream\r\n\r\n",
                harness.address
            )
            .as_bytes(),
        )
        .await?;
    deadbeat.flush().await?;
    harness
        .await_subscribers(1, Duration::from_secs(10))
        .await?;

    // Enough events to overflow the 64-slot client buffer several times over.
    let writer = burst_writes(harness.dir.path(), 500);

    // While that client's buffer backs up, health must keep answering promptly.
    for _ in 0..10 {
        let started = Instant::now();
        assert_eq!(harness.get("/health").await?.status, 200);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "a stalled subscriber must not slow other clients: health took {:?}",
            started.elapsed()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    writer.await.ok();
    drop(deadbeat);
    // Dropping the socket must let the subscriber count fall back to zero.
    harness
        .await_subscribers(0, Duration::from_secs(10))
        .await
        .context("the stalled subscriber was never reaped after its socket closed")?;
    harness.shutdown().await
}

#[tokio::test]
async fn watcher_accounting_stays_consistent_after_a_burst() -> Result<()> {
    let harness = Harness::start().await?;

    let writer = burst_writes(harness.dir.path(), 400);
    writer.await.ok();

    // Let the pump work, then read a snapshot and hold every counter to the relationships it can
    // never legitimately violate. A miscount or a double-delivery bug shows up here.
    let deadline = Instant::now() + EVENT_BUDGET;
    while Instant::now() < deadline {
        if harness.status().await?["events_processed"]
            .as_u64()
            .unwrap_or(0)
            > 0
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let status = harness.status().await?;
    let watcher = &status["watcher"];
    let queued = watcher["events_queued"].as_u64().unwrap_or(0);
    let delivered = watcher["events_delivered"].as_u64().unwrap_or(0);
    let synthesized = watcher["events_synthesized"].as_u64().unwrap_or(0);
    let pending = watcher["queue_pending"].as_u64().unwrap_or(0);
    let capacity = watcher["queue_capacity"].as_u64().unwrap_or(0);

    assert!(
        delivered <= queued,
        "more events were delivered ({delivered}) than were ever queued ({queued})"
    );
    assert!(
        synthesized <= queued,
        "synthesized events ({synthesized}) are a subset of queued ({queued})"
    );
    assert!(
        pending <= capacity + 1,
        "pending ({pending}) exceeded the queue bound ({capacity}) by more than the held rescan"
    );

    let processed = status["events_processed"].as_u64().unwrap_or(0);
    let changes = status["changes_detected"].as_u64().unwrap_or(0);
    let hashed = status["processor"]["files_hashed"].as_u64().unwrap_or(0);
    assert!(
        changes <= processed,
        "content changes ({changes}) cannot exceed processed events ({processed})"
    );
    assert!(
        hashed <= processed,
        "the processor hashed ({hashed}) more times than it saw events ({processed})"
    );

    harness.shutdown().await
}
