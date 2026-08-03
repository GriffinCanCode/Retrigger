//! The HTTP API.
//!
//! HTTP because the point of the daemon is to be reachable from processes it did not spawn, in
//! languages it does not know about. A bespoke binary protocol would be faster on paper and
//! unusable in practice: `curl` is a debugger, every language has a client, and server-sent
//! events give a streaming endpoint that survives proxies and needs no framing code on either
//! side.
//!
//! | route | method | purpose |
//! |---|---|---|
//! | `/` | GET | what this daemon serves |
//! | `/health` | GET | liveness, for supervisors |
//! | `/status` | GET | everything in [`DaemonStats`] |
//! | `/metrics` | GET | the same numbers in Prometheus exposition format |
//! | `/events` | GET | server-sent stream of processed events |
//! | `/snapshot` | GET | `?path=...`, a self-describing inventory of that tree right now |
//! | `/watch` | POST | `{"path": "...", "recursive": true}` |
//! | `/unwatch` | POST | `{"path": "..."}` |
//! | `/shutdown` | POST | graceful shutdown |
//!
//! # No authentication
//!
//! There is none, which is why [`ServerConfig::bind_address`](crate::config::ServerConfig)
//! defaults to loopback. Anything that can reach this port can make the daemon watch any path
//! the daemon's user can read, and can read the change stream of everything it watches.

use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use retrigger_system::{SnapshotEnvelope, WatchError};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tracing::info;

use crate::daemon::{Daemon, DaemonStats, VERSION};

/// How many rendered events may sit between the fan-out and one slow HTTP client.
///
/// Small on purpose: the daemon's own broadcast ring is the buffer that matters, and a client
/// that cannot keep up should be told it lagged rather than have megabytes of JSON queued for it.
const EVENT_BUFFER: usize = 64;

/// Build the router for a daemon.
pub fn router(daemon: Arc<Daemon>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/health", get(health))
        .route("/status", get(status))
        .route("/metrics", get(metrics))
        .route("/events", get(events))
        .route("/snapshot", get(snapshot))
        .route("/watch", post(watch))
        .route("/unwatch", post(unwatch))
        .route("/shutdown", post(shutdown))
        .with_state(daemon)
}

/// Serve until the daemon is asked to shut down.
///
/// # Errors
///
/// If the server stops for a reason other than the shutdown signal.
pub async fn serve(daemon: Arc<Daemon>, listener: TcpListener) -> Result<()> {
    let signal = Arc::clone(&daemon);
    axum::serve(listener, router(daemon))
        .with_graceful_shutdown(async move { signal.shutdown_requested().await })
        .await
        .context("the HTTP server stopped unexpectedly")
}

async fn index() -> Json<serde_json::Value> {
    Json(json!({
        "name": "retrigger",
        "version": VERSION,
        "endpoints": {
            "GET /health": "liveness",
            "GET /status": "watcher, cache, and process statistics",
            "GET /metrics": "the same numbers, Prometheus exposition format",
            "GET /events": "server-sent stream of processed file events",
            "GET /snapshot": "?path=..., a self-describing inventory of that tree right now",
            "POST /watch": "{\"path\": \"...\", \"recursive\": true}",
            "POST /unwatch": "{\"path\": \"...\"}",
            "POST /shutdown": "graceful shutdown",
        },
    }))
}

async fn health(State(daemon): State<Arc<Daemon>>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "version": VERSION,
        "watching": daemon.stats().running,
    }))
}

async fn status(State(daemon): State<Arc<Daemon>>) -> Json<DaemonStats> {
    Json(daemon.stats())
}

async fn metrics(State(daemon): State<Arc<Daemon>>) -> Response {
    (
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        prometheus(&daemon.stats()),
    )
        .into_response()
}

/// The change stream. One SSE `change` event per processed file event.
///
/// A subscriber that falls behind receives a `lagged` event carrying how many it missed, which
/// means exactly what a rescan signal means: this stream is no longer a complete description of
/// the tree, so re-read what you care about.
///
/// The forwarding task ends on any of three conditions — the daemon shutting down, the client
/// disconnecting, or the event channel closing — because a stream that outlives its reason to
/// exist would hold graceful shutdown open and keep the subscriber count wrong.
async fn events(State(daemon): State<Arc<Daemon>>) -> impl IntoResponse {
    let guard = daemon.track_subscriber();
    let mut receiver = daemon.subscribe();
    let (sender, stream) = mpsc::channel::<Result<Event, Infallible>>(EVENT_BUFFER);

    tokio::spawn(async move {
        // Owned by the task, so the subscriber count falls exactly when this loop ends.
        let _guard = guard;
        loop {
            let event = tokio::select! {
                () = daemon.shutdown_requested() => break,
                () = sender.closed() => break,
                received = receiver.recv() => match received {
                    Ok(event) => Event::default()
                        .event("change")
                        .json_data(event)
                        // Serializing a ProcessedEvent cannot fail today, but a panic here would
                        // take out one client's stream for a reason it could never act on.
                        .unwrap_or_else(|err| {
                            Event::default().event("error").data(err.to_string())
                        }),
                    Err(RecvError::Lagged(missed)) => Event::default()
                        .event("lagged")
                        .data(missed.to_string()),
                    Err(RecvError::Closed) => break,
                },
            };
            if sender.send(Ok(event)).await.is_err() {
                break;
            }
        }
    });

    Sse::new(ReceiverStream::new(stream)).keep_alive(KeepAlive::default())
}

/// The shape a path must have to be accepted over HTTP.
///
/// This is the daemon's trust boundary: the library beneath takes whatever the program embedding
/// it asks for, because that caller is already trusted, while this surface accepts JSON from
/// anything that can reach the port. So the vetting lives here and not in `retrigger-system`,
/// which would break an in-process caller's perfectly reasonable `watch("./src")`.
///
/// The rule is lexical on purpose — absolute, and no `.` or `..` components — so it gives the
/// same answer on every platform and needs no I/O. It deliberately does *not* require the path
/// to equal its canonical form: on macOS a temporary directory is reached through `/var`, which
/// is a symlink to `/private/var`, and rejecting that would refuse ordinary paths.
///
/// A traversal expression is refused because a request naming `../../../etc/passwd` is a request
/// whose author does not know what they are asking for. This is not a confinement boundary and
/// does not pretend to be one: an absolute path is still accepted, so this narrows the ways to
/// say a thing, not the things that can be said. Confinement, if it is ever wanted, belongs in
/// configuration next to `bind_address`.
fn vet(path: &Path) -> Result<(), ApiError> {
    let refuse = |reason: &str| {
        Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            error: format!("{}: {reason}", path.display()),
        })
    };

    // A NUL can never appear in a real path, and without this it reaches the filesystem call and
    // comes back as an unclassified error — a 500 for what is plainly a bad request.
    if path.as_os_str().as_encoded_bytes().contains(&0) {
        return refuse("a watch path must not contain a NUL byte");
    }
    if !path.is_absolute() {
        return refuse("a watch path must be absolute");
    }
    // Scanning the raw segments rather than `Path::components`, which quietly folds away a `.`
    // and so would report a path free of the very thing being looked for.
    let separators: &[u8] = if cfg!(windows) { b"/\\" } else { b"/" };
    if path
        .as_os_str()
        .as_encoded_bytes()
        .split(|byte| separators.contains(byte))
        .any(|segment| segment == b"." || segment == b"..")
    {
        return refuse("a watch path must name its target directly: '.' and '..' are not accepted");
    }
    Ok(())
}

/// `GET /snapshot` query string.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotQuery {
    path: PathBuf,
}

/// Crawl `path`'s current contents and return a self-describing, portable inventory.
///
/// Reuses [`vet`], the same trust boundary `/watch` and `/unwatch` sit behind: this reads
/// arbitrary directories the daemon's user can see, so it is refused the same paths a watch
/// request would be. Unlike a watch, nothing here is registered — a caller polling `/snapshot` in
/// a loop is exactly as safe as calling it once.
async fn snapshot(
    State(daemon): State<Arc<Daemon>>,
    Query(request): Query<SnapshotQuery>,
) -> Result<Json<SnapshotEnvelope>, ApiError> {
    vet(&request.path)?;
    let entries = daemon.snapshot(&request.path)?;
    Ok(Json(SnapshotEnvelope::new(entries)))
}

async fn watch(
    State(daemon): State<Arc<Daemon>>,
    Json(request): Json<WatchRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    vet(&request.path)?;
    daemon.watch(&request.path, request.recursive)?;
    Ok(Json(json!({ "watched": daemon.stats().watched })))
}

async fn unwatch(
    State(daemon): State<Arc<Daemon>>,
    Json(request): Json<UnwatchRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    vet(&request.path)?;
    daemon.unwatch(&request.path)?;
    Ok(Json(json!({ "watched": daemon.stats().watched })))
}

async fn shutdown(State(daemon): State<Arc<Daemon>>) -> (StatusCode, Json<serde_json::Value>) {
    info!("shutdown requested over the API");
    daemon.request_shutdown();
    (StatusCode::ACCEPTED, Json(json!({ "stopping": true })))
}

/// `POST /watch` body.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WatchRequest {
    path: PathBuf,
    #[serde(default = "yes")]
    recursive: bool,
}

/// `POST /unwatch` body.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnwatchRequest {
    path: PathBuf,
}

const fn yes() -> bool {
    true
}

/// An error with the status code that describes it.
#[derive(Debug, Serialize)]
struct ApiError {
    #[serde(skip)]
    status: StatusCode,
    error: String,
}

impl From<WatchError> for ApiError {
    fn from(err: WatchError) -> Self {
        // Each of these is actionable by the client, so each gets the status code that says so
        // rather than a uniform 500 that forces string matching.
        let status = match err {
            WatchError::NotFound(_) => StatusCode::NOT_FOUND,
            WatchError::PermissionDenied(_) => StatusCode::FORBIDDEN,
            WatchError::InvalidPattern(_) => StatusCode::BAD_REQUEST,
            WatchError::WatchLimitExceeded(_) | WatchError::ScanTooLarge(_) => {
                StatusCode::INSUFFICIENT_STORAGE
            }
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self {
            status,
            error: err.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self)).into_response()
    }
}

/// Render statistics in Prometheus exposition format.
///
/// Hand-rendered rather than pulled from a metrics facade: there are a dozen numbers, they are
/// already collected by the watcher and the processor, and a registry that mirrors them would be
/// a second source of truth to keep in sync.
#[must_use]
pub fn prometheus(stats: &DaemonStats) -> String {
    let mut out = String::with_capacity(2048);
    let mut counter = |name: &str, help: &str, value: u64| {
        push_metric(&mut out, name, help, "counter", value);
    };
    counter(
        "retrigger_events_processed_total",
        "File events the daemon has processed.",
        stats.events_processed,
    );
    counter(
        "retrigger_content_changes_total",
        "Processed events whose file contents actually differed.",
        stats.changes_detected,
    );
    counter(
        "retrigger_rescans_total",
        "Rescan signals raised because events were lost.",
        stats.rescans,
    );
    counter(
        "retrigger_events_queued_total",
        "Events accepted into the watcher's bounded queue.",
        stats.watcher.events_queued,
    );
    counter(
        "retrigger_events_dropped_total",
        "Events discarded because the watcher's queue was full.",
        stats.watcher.events_dropped,
    );
    counter(
        "retrigger_events_synthesized_total",
        "Events the watcher produced by reading a newly created directory.",
        stats.watcher.events_synthesized,
    );
    counter(
        "retrigger_files_hashed_total",
        "Files read and fingerprinted.",
        stats.processor.files_hashed,
    );
    counter(
        "retrigger_hash_errors_total",
        "Files that could not be read for fingerprinting.",
        stats.processor.hash_errors,
    );
    counter(
        "retrigger_cache_hits_total",
        "Fingerprint look-ups served from cache.",
        stats.processor.cache_hits,
    );
    counter(
        "retrigger_cache_misses_total",
        "Fingerprint look-ups that found nothing fresh.",
        stats.processor.cache_misses,
    );

    let mut gauge = |name: &str, help: &str, value: u64| {
        push_metric(&mut out, name, help, "gauge", value);
    };
    gauge(
        "retrigger_uptime_seconds",
        "Seconds since the daemon started.",
        stats.uptime_seconds,
    );
    gauge(
        "retrigger_up",
        "1 when the watcher backend is attached and the event pump is running.",
        u64::from(stats.running),
    );
    gauge(
        "retrigger_subscribers",
        "Event streams currently connected.",
        stats.subscribers,
    );
    gauge(
        "retrigger_watched_paths",
        "Watch roots currently registered.",
        stats.watcher.watched_paths as u64,
    );
    gauge(
        "retrigger_queue_pending",
        "Events awaiting delivery.",
        stats.watcher.queue_pending as u64,
    );
    gauge(
        "retrigger_queue_capacity",
        "Configured bound on the event queue.",
        stats.watcher.queue_capacity as u64,
    );
    gauge(
        "retrigger_cache_entries",
        "Content fingerprints currently cached.",
        stats.processor.entries as u64,
    );
    gauge(
        "retrigger_cache_capacity",
        "Hard ceiling on cached fingerprints.",
        stats.processor.capacity as u64,
    );
    gauge(
        "retrigger_cache_bytes",
        "Approximate heap held by the fingerprint cache.",
        stats.processor.cache_bytes as u64,
    );
    out
}

fn push_metric(out: &mut String, name: &str, help: &str, kind: &str, value: u64) {
    use std::fmt::Write as _;
    // Writing to a String is infallible; the Result exists only because Write is shared with I/O.
    let _ = writeln!(
        out,
        "# HELP {name} {help}\n# TYPE {name} {kind}\n{name} {value}"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::DaemonConfig;

    fn stats() -> DaemonStats {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut config = DaemonConfig::default();
        config.server.port = 0;
        config.watcher.paths = vec![crate::config::WatchPath {
            path: dir.path().to_path_buf(),
            recursive: true,
        }];
        Daemon::new(config).expect("daemon").stats()
    }

    #[test]
    fn prometheus_output_is_well_formed() {
        let rendered = prometheus(&stats());
        let lines: Vec<&str> = rendered.lines().collect();
        assert!(!lines.is_empty());

        let mut samples = 0;
        for chunk in lines.chunks(3) {
            assert_eq!(
                chunk.len(),
                3,
                "every metric is HELP, TYPE, then one sample"
            );
            let (help, kind, sample) = (chunk[0], chunk[1], chunk[2]);
            assert!(help.starts_with("# HELP retrigger_"), "{help}");
            assert!(
                kind.starts_with("# TYPE retrigger_")
                    && (kind.ends_with(" counter") || kind.ends_with(" gauge")),
                "{kind}"
            );

            let mut parts = sample.split(' ');
            let name = parts.next().unwrap_or_default();
            let value = parts.next().unwrap_or_default();
            assert!(name.starts_with("retrigger_"), "{sample}");
            assert!(
                parts.next().is_none(),
                "a sample carries one value: {sample}"
            );
            assert!(
                value.parse::<u64>().is_ok(),
                "sample value must be numeric: {sample}"
            );
            assert!(
                help.contains(name) && kind.contains(name),
                "the HELP and TYPE lines must describe the sample below them: {sample}"
            );
            samples += 1;
        }
        assert!(samples >= 15, "only {samples} metrics were rendered");
    }

    #[test]
    fn a_fresh_daemon_reports_itself_as_down() {
        let rendered = prometheus(&stats());
        assert!(
            rendered.contains("\nretrigger_up 0\n"),
            "a daemon that has not started must not claim to be up:\n{rendered}"
        );
        assert!(rendered.contains("\nretrigger_watched_paths 1\n"));
    }

    #[test]
    fn watch_errors_map_onto_status_codes_a_client_can_act_on() {
        let cases = [
            (
                WatchError::NotFound(PathBuf::from("/x")),
                StatusCode::NOT_FOUND,
            ),
            (
                WatchError::PermissionDenied(PathBuf::from("/x")),
                StatusCode::FORBIDDEN,
            ),
            (
                WatchError::WatchLimitExceeded(PathBuf::from("/x")),
                StatusCode::INSUFFICIENT_STORAGE,
            ),
            (
                WatchError::InvalidPattern("nope".to_owned()),
                StatusCode::BAD_REQUEST,
            ),
            (
                WatchError::AlreadyRunning,
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
        ];
        for (err, expected) in cases {
            let message = err.to_string();
            let api = ApiError::from(err);
            assert_eq!(api.status, expected, "{message}");
            assert_eq!(
                api.error, message,
                "the client must be told what went wrong"
            );
        }
    }

    #[test]
    fn a_watch_request_defaults_to_recursive_and_rejects_unknown_keys() {
        let request: WatchRequest =
            serde_json::from_str(r#"{"path":"/tmp"}"#).expect("minimal body");
        assert!(request.recursive);

        let explicit: WatchRequest =
            serde_json::from_str(r#"{"path":"/tmp","recursive":false}"#).expect("full body");
        assert!(!explicit.recursive);

        assert!(
            serde_json::from_str::<WatchRequest>(r#"{"path":"/tmp","recursve":false}"#).is_err(),
            "a misspelled key must not silently mean the default"
        );
        assert!(serde_json::from_str::<WatchRequest>("{}").is_err());
    }

    #[test]
    fn a_watch_path_must_name_its_target_directly() {
        // What counts as absolute is the platform's business, so the accepted shapes differ.
        let accepted: &[&str] = if cfg!(windows) {
            &[r"C:\Windows\Temp", r"C:\a\b.c\d-e_f"]
        } else {
            &["/tmp", "/var/folders/zz/T/retrigger", "/a/b.c/d-e_f"]
        };
        for path in accepted {
            assert!(
                vet(Path::new(path)).is_ok(),
                "{path} is an ordinary absolute path and must be accepted"
            );
        }

        // Every one of these is refused on every platform: the Unix-shaped ones fail the
        // traversal rule where paths are Unix-shaped and the absoluteness rule where they aren't.
        for refused in [
            "../../../../../../etc/passwd",
            "/tmp/../etc/passwd",
            "/tmp/./x",
            "relative/path",
            "",
        ] {
            let err = vet(Path::new(refused))
                .expect_err("a path that does not name its target must be refused");
            assert_eq!(
                err.status,
                StatusCode::BAD_REQUEST,
                "{refused} is the client's mistake, not the server's"
            );
        }
    }

    #[test]
    fn a_nul_in_a_path_is_the_clients_fault_not_a_server_error() {
        // Without an explicit check this reaches the filesystem call and returns an unclassified
        // 500, which tells a client the daemon broke rather than that the request was nonsense.
        // A Rust string literal may hold a NUL, so this needs no platform-specific construction.
        let err = vet(Path::new("/tmp/has\0nul")).expect_err("an embedded NUL must be refused");
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
    }
}
