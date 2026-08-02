//! The `retrigger` command.
//!
//! Six subcommands, all of which do what they say. `start` runs the daemon; `stop` and `status`
//! talk to a running one over its own HTTP API; `validate` and `config` work on the
//! configuration file; `benchmark` measures the two things this daemon's speed actually depends
//! on — how fast the hash engine reads bytes and how fast the watcher delivers events.

#![forbid(unsafe_code)]

use std::io::Write as _;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use retrigger_daemon::client::{self, Reply};
use retrigger_daemon::config::{
    DaemonConfig, LogFormat, LogLevel, LoggingConfig, DEFAULT_CONFIG_FILE,
};
use retrigger_daemon::daemon::{Daemon, DaemonStats, VERSION};
use retrigger_daemon::{api, Xxh3Hasher};
use retrigger_system::{FileEventProcessor, Watcher, WatcherConfig};
use tokio::net::TcpListener;
use tracing::{error, info, warn};
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::util::SubscriberInitExt as _;

/// How long `status` and `stop` wait for a single request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// How long `stop` waits for the daemon to actually exit.
const STOP_TIMEOUT: Duration = Duration::from_secs(15);

/// An optional standalone file watcher, shared by several processes.
///
/// It is optional on purpose: @retrigger/core watches in-process and needs nothing from here.
/// Run this only when more than one process must watch the same tree.
#[derive(Parser)]
#[command(name = "retrigger", version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run the daemon.
    Start(StartArgs),
    /// Ask a running daemon to shut down.
    Stop(StopArgs),
    /// Report on a running daemon.
    Status(StatusArgs),
    /// Check a configuration file.
    Validate(ValidateArgs),
    /// Write a default configuration file.
    Config(ConfigArgs),
    /// Measure hashing throughput and watcher delivery.
    Benchmark(BenchmarkArgs),
}

#[derive(Args)]
struct StartArgs {
    /// Configuration file. Without this, `retrigger.toml` is used if it exists, and built-in
    /// defaults otherwise; with it, a missing file is an error.
    #[arg(short, long)]
    config: Option<PathBuf>,

    /// Accepted for compatibility. The daemon always runs in the foreground: backgrounding is
    /// the job of a supervisor (systemd, launchd, `spawn(detached)`), which can restart it and
    /// capture its output, neither of which a self-daemonizing process does well.
    #[arg(short, long)]
    foreground: bool,

    /// Log at debug level, overriding the configuration file.
    #[arg(short, long)]
    debug: bool,

    /// Override the bind address. Must be a literal IP.
    #[arg(long)]
    bind: Option<String>,

    /// Override the port. `0` asks the OS for an ephemeral one.
    #[arg(short, long)]
    port: Option<u16>,
}

/// Where to find a running daemon.
#[derive(Args)]
struct Endpoint {
    /// Configuration file to read the address from.
    #[arg(short, long)]
    config: Option<PathBuf>,

    /// Override the address.
    #[arg(long)]
    bind: Option<String>,

    /// Override the port.
    #[arg(short, long)]
    port: Option<u16>,
}

#[derive(Args)]
struct StopArgs {
    #[command(flatten)]
    endpoint: Endpoint,

    /// Return as soon as the shutdown has been requested, without waiting for the daemon to
    /// finish. This does not kill anything: there is no signal to send, because the daemon's own
    /// shutdown path is bounded and portable, whereas SIGKILL is neither.
    #[arg(short, long)]
    force: bool,
}

#[derive(Args)]
struct StatusArgs {
    #[command(flatten)]
    endpoint: Endpoint,

    /// Print the raw JSON the daemon returned.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct ValidateArgs {
    /// Configuration file to check.
    #[arg(short, long, default_value = DEFAULT_CONFIG_FILE)]
    config: PathBuf,
}

#[derive(Args)]
struct ConfigArgs {
    /// Where to write. `-` writes to standard output.
    #[arg(short, long, default_value = DEFAULT_CONFIG_FILE)]
    output: PathBuf,

    /// Overwrite an existing file.
    #[arg(long)]
    force: bool,
}

#[derive(Args)]
struct BenchmarkArgs {
    /// Directory to create the scratch tree in. It is removed afterwards.
    #[arg(short, long, default_value = ".")]
    directory: PathBuf,

    /// Number of files to write.
    #[arg(short, long, default_value_t = 1000, value_parser = at_least_one)]
    files: usize,

    /// Size of each file, in bytes.
    #[arg(short, long, default_value_t = 1024, value_parser = at_least_one)]
    size: usize,
}

fn at_least_one(raw: &str) -> Result<usize, String> {
    match raw.parse::<usize>() {
        Ok(0) => Err("must be at least 1".to_owned()),
        Ok(value) => Ok(value),
        Err(err) => Err(err.to_string()),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Commands::Start(args) => start(args).await,
        Commands::Stop(args) => stop(args).await,
        Commands::Status(args) => status(args).await,
        Commands::Validate(args) => validate(&args.config),
        Commands::Config(args) => generate_config(&args),
        Commands::Benchmark(args) => benchmark(&args),
    }
}

// ------------------------------------------------------------------------ start

async fn start(args: StartArgs) -> Result<()> {
    let (mut config, source) = resolve_config(args.config.as_deref())?;
    if let Some(bind) = args.bind {
        config.server.bind_address = bind;
    }
    if let Some(port) = args.port {
        config.server.port = port;
    }
    if args.debug {
        config.logging.level = LogLevel::Debug;
    }
    config.validate()?;
    init_tracing(&config.logging)?;

    match &source {
        Some(path) => info!(config = %path.display(), "loaded configuration"),
        None => info!("no configuration file found; using built-in defaults"),
    }
    if !args.foreground {
        info!("running in the foreground; use a supervisor or a detached spawn to background it");
    }
    if config.watcher.paths.is_empty() {
        warn!("no watch paths are configured; add some with POST /watch or in [[watcher.paths]]");
    }

    // Bind before building the daemon: a port conflict is the most common startup failure, and
    // failing before any kernel watch is installed keeps the failure cheap and the message clear.
    let requested = config.socket_addr()?;
    let listener = TcpListener::bind(requested)
        .await
        .with_context(|| format!("could not bind {requested}"))?;
    let bound = listener.local_addr().unwrap_or(requested);

    let daemon = Arc::new(Daemon::new(config)?);
    daemon.set_address(bound);
    daemon.start()?;
    info!(version = VERSION, address = %bound, "retrigger daemon listening");

    let signals = Arc::clone(&daemon);
    tokio::spawn(async move {
        wait_for_signal().await;
        info!("signal received; shutting down");
        signals.request_shutdown();
    });

    let served = api::serve(Arc::clone(&daemon), listener).await;
    daemon.stop();
    info!("shutdown complete");
    served
}

/// Resolve `SIGINT`/`SIGTERM` into a single future.
///
/// A handler that cannot be installed is reported and then waits forever rather than aborting:
/// losing the ability to shut down cleanly is bad, but taking the daemon down at startup because
/// of it is worse, and `stop` still works over the API.
async fn wait_for_signal() {
    let interrupt = async {
        if let Err(err) = tokio::signal::ctrl_c().await {
            error!(error = %err, "could not listen for Ctrl-C");
            std::future::pending::<()>().await;
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(err) => {
                error!(error = %err, "could not listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = interrupt => {}
        () = terminate => {}
    }
}

// ------------------------------------------------------------------- stop/status

async fn stop(args: StopArgs) -> Result<()> {
    let address = args.endpoint.address()?;

    match client::post(address, "/shutdown", REQUEST_TIMEOUT).await? {
        // Stopping something that is already stopped is a success. Scripts call `stop` to reach
        // a state, not to perform an action.
        Reply::Unreachable(reason) => {
            println!("no daemon is listening on {address} ({reason})");
            return Ok(());
        }
        Reply::Answered(response) if !response.is_success() => {
            bail!(
                "the daemon on {address} refused to stop (HTTP {}): {}",
                response.status,
                response.body.trim()
            );
        }
        Reply::Answered(_) => {}
    }

    if args.force {
        println!("shutdown requested on {address}; not waiting for it to finish");
        return Ok(());
    }

    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if !client::is_listening(address, REQUEST_TIMEOUT).await {
            println!("daemon on {address} stopped");
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!(
        "the daemon on {address} accepted the shutdown request but was still listening after {}s",
        STOP_TIMEOUT.as_secs()
    )
}

async fn status(args: StatusArgs) -> Result<()> {
    let address = args.endpoint.address()?;

    let response = match client::get(address, "/status", REQUEST_TIMEOUT).await? {
        Reply::Unreachable(reason) => {
            bail!("no daemon is listening on {address} ({reason})")
        }
        Reply::Answered(response) => response,
    };
    if !response.is_success() {
        bail!(
            "the daemon on {address} returned HTTP {}: {}",
            response.status,
            response.body.trim()
        );
    }

    if args.json {
        println!("{}", response.body.trim());
        return Ok(());
    }

    let stats: DaemonStats = serde_json::from_str(&response.body)
        .with_context(|| format!("{address} answered, but not with a status this build knows"))?;
    print_status(&stats);
    Ok(())
}

fn print_status(stats: &DaemonStats) {
    let out = std::io::stdout();
    let mut out = out.lock();
    // Printing to a closed stdout (`retrigger status | head`) is not worth an error path.
    let _ = writeln!(out, "retrigger {} (pid {})", stats.version, stats.pid);
    let _ = writeln!(
        out,
        "  address     {}",
        stats.address.as_deref().unwrap_or("not bound")
    );
    let _ = writeln!(
        out,
        "  uptime      {}",
        human_duration(stats.uptime_seconds)
    );
    let _ = writeln!(
        out,
        "  watching    {} ({:?} backend, {} hash kernel)",
        if stats.running { "yes" } else { "no" },
        stats.backend,
        stats.simd_level
    );
    for path in &stats.watched {
        let _ = writeln!(
            out,
            "              {} {}",
            path.path.display(),
            if path.recursive {
                "(recursive)"
            } else {
                "(this level only)"
            }
        );
    }
    let _ = writeln!(out, "  subscribers {}", stats.subscribers);
    let _ = writeln!(
        out,
        "  events      {} processed, {} content changes, {} rescans",
        stats.events_processed, stats.changes_detected, stats.rescans
    );
    let _ = writeln!(
        out,
        "  queue       {}/{} pending, {} dropped, {} synthesized",
        stats.watcher.queue_pending,
        stats.watcher.queue_capacity,
        stats.watcher.events_dropped,
        stats.watcher.events_synthesized
    );
    let _ = writeln!(
        out,
        "  hashes      {} files, {} errors",
        stats.processor.files_hashed, stats.processor.hash_errors
    );
    let _ = writeln!(
        out,
        "  cache       {}/{} entries, {} hits, {} misses, {} KiB",
        stats.processor.entries,
        stats.processor.capacity,
        stats.processor.cache_hits,
        stats.processor.cache_misses,
        stats.processor.cache_bytes / 1024
    );
}

fn human_duration(seconds: u64) -> String {
    let (days, hours, minutes, secs) = (
        seconds / 86_400,
        (seconds % 86_400) / 3600,
        (seconds % 3600) / 60,
        seconds % 60,
    );
    match (days, hours, minutes) {
        (0, 0, 0) => format!("{secs}s"),
        (0, 0, _) => format!("{minutes}m {secs}s"),
        (0, _, _) => format!("{hours}h {minutes}m {secs}s"),
        _ => format!("{days}d {hours}h {minutes}m"),
    }
}

// ------------------------------------------------------------------------ config

fn validate(path: &Path) -> Result<()> {
    let config = DaemonConfig::load(path)?;

    let mut missing = 0;
    for entry in &config.watcher.paths {
        if !entry.path.exists() {
            missing += 1;
            eprintln!(
                "warning: {} does not exist on this machine; `start` will fail here",
                entry.path.display()
            );
        }
    }

    println!("{} is valid", path.display());
    println!(
        "  listens on  {}",
        config
            .socket_addr()
            .map_or_else(|_| "?".to_owned(), |address| address.to_string())
    );
    println!(
        "  watches     {} path(s){}",
        config.watcher.paths.len(),
        if missing > 0 {
            format!(", {missing} of which do not exist here")
        } else {
            String::new()
        }
    );
    println!(
        "  filters     {} include, {} exclude pattern(s)",
        config.patterns.include.len(),
        config.patterns.exclude.len()
    );
    Ok(())
}

fn generate_config(args: &ConfigArgs) -> Result<()> {
    let rendered = DaemonConfig::default().to_toml()?;

    if args.output == Path::new("-") {
        print!("{rendered}");
        return Ok(());
    }
    if args.output.exists() && !args.force {
        bail!(
            "{} already exists; pass --force to overwrite it",
            args.output.display()
        );
    }
    std::fs::write(&args.output, &rendered)
        .with_context(|| format!("could not write {}", args.output.display()))?;
    println!("wrote {}", args.output.display());
    Ok(())
}

fn resolve_config(explicit: Option<&Path>) -> Result<(DaemonConfig, Option<PathBuf>)> {
    match explicit {
        // Asked for by name: a missing file is a mistake, not an invitation to use defaults.
        Some(path) => Ok((DaemonConfig::load(path)?, Some(path.to_path_buf()))),
        None => {
            let default = Path::new(DEFAULT_CONFIG_FILE);
            if default.exists() {
                Ok((DaemonConfig::load(default)?, Some(default.to_path_buf())))
            } else {
                Ok((DaemonConfig::default(), None))
            }
        }
    }
}

impl Endpoint {
    fn address(&self) -> Result<SocketAddr> {
        let (mut config, _) = resolve_config(self.config.as_deref())?;
        if let Some(bind) = &self.bind {
            config.server.bind_address.clone_from(bind);
        }
        if let Some(port) = self.port {
            config.server.port = port;
        }
        let address = config.socket_addr()?;
        if address.port() == 0 {
            bail!(
                "port 0 means 'let the OS choose', so there is no address to talk to; \
                 pass --port with the port the daemon logged at startup"
            );
        }
        Ok(address)
    }
}

fn init_tracing(logging: &LoggingConfig) -> Result<()> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(logging.level.directive()));
    let registry = tracing_subscriber::registry().with(filter);
    let layer = tracing_subscriber::fmt::layer();

    match logging.format {
        LogFormat::Compact => registry.with(layer.compact()).try_init(),
        LogFormat::Pretty => registry.with(layer.pretty()).try_init(),
        LogFormat::Json => registry.with(layer.json()).try_init(),
    }
    .map_err(|err| anyhow!("could not install the log subscriber: {err}"))
}

// --------------------------------------------------------------------- benchmark

/// A directory that removes itself, so a benchmark that fails part way through does not leave a
/// thousand files behind.
struct Scratch {
    path: PathBuf,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Err(err) = std::fs::remove_dir_all(&self.path) {
            eprintln!("warning: could not remove {}: {err}", self.path.display());
        }
    }
}

fn benchmark(args: &BenchmarkArgs) -> Result<()> {
    let total_bytes = (args.files as u64).saturating_mul(args.size as u64);

    println!("hash engine");
    println!("  kernel        {}", retrigger_core::active_level());
    println!(
        "  available     {}",
        retrigger_core::available_levels()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    );
    let iterations = u32::try_from(args.files).unwrap_or(u32::MAX);
    let measured = retrigger_core::benchmark(args.size, iterations);
    println!("  throughput    {:.1} MiB/s", measured.throughput_mbps);
    println!(
        "  hashed        {} bytes in {:?}",
        measured.bytes_hashed,
        Duration::from_nanos(measured.elapsed_ns)
    );

    let scratch = Scratch {
        path: args
            .directory
            .join(format!(".retrigger-bench-{}", std::process::id())),
    };
    std::fs::create_dir_all(&scratch.path)
        .with_context(|| format!("could not create {}", scratch.path.display()))?;

    // The same pieces the daemon runs, minus the HTTP server: this measures the watcher and the
    // hasher, not the network stack.
    let watcher = Watcher::new(WatcherConfig {
        capacity: args.files.saturating_mul(2).max(1024),
        debounce: Duration::ZERO,
        ..WatcherConfig::default()
    })?;
    watcher.watch(&scratch.path, true)?;
    watcher.start()?;
    let processor = FileEventProcessor::with_hasher(Xxh3Hasher);

    println!("\nwatcher ({:?})", watcher.backend());
    let contents = vec![b'r'; args.size];
    let writing = Instant::now();
    for index in 0..args.files {
        std::fs::write(scratch.path.join(format!("f{index}.bin")), &contents)
            .with_context(|| format!("could not write file {index}"))?;
    }
    let written = writing.elapsed();
    println!(
        "  wrote         {} files x {} B ({} KiB) in {written:?}",
        args.files,
        args.size,
        total_bytes / 1024
    );

    // Drain until the stream goes quiet. A watcher is allowed to coalesce and to drop under
    // pressure, so this counts what arrived rather than asserting what should have.
    let draining = Instant::now();
    let mut delivered = 0_u64;
    let mut changed = 0_u64;
    while let Some(event) = watcher.recv_timeout(Duration::from_millis(500)) {
        let processed = processor.process(event);
        delivered += 1;
        if processed.content_changed {
            changed += 1;
        }
    }
    let draining = draining.elapsed();
    watcher.stop()?;

    let stats = watcher.stats();
    println!("  delivered     {delivered} events ({changed} content changes) in {draining:?}");
    if draining.as_secs_f64() > 0.0 {
        println!(
            "  rate          {:.0} events/s",
            delivered as f64 / draining.as_secs_f64()
        );
    }
    println!(
        "  queue         {} queued, {} dropped, {} synthesized",
        stats.events_queued, stats.events_dropped, stats.events_synthesized
    );

    let cache = processor.stats();
    println!(
        "  hashed        {} files, {} errors",
        cache.files_hashed, cache.hash_errors
    );
    println!(
        "  cache         {}/{} entries, {} hits, {} misses",
        cache.entries, cache.capacity, cache.cache_hits, cache.cache_misses
    );

    if delivered < args.files as u64 {
        println!(
            "\nnote: fewer events arrived than files were written. That is expected on a \
             backend that coalesces (macOS FSEvents) and under queue pressure; \
             `dropped` above says whether anything was lost."
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory as _;

    #[test]
    fn the_cli_definition_is_self_consistent() {
        Cli::command().debug_assert();
    }

    #[test]
    fn version_and_help_are_answered_rather_than_rejected() {
        // `retrigger --version` is load-bearing: the container healthcheck, the npm CLI shim,
        // and the post-install check all run exactly this and require exit 0.
        let err = Cli::try_parse_from(["retrigger", "--version"])
            .err()
            .expect("--version short-circuits parsing");
        assert_eq!(err.kind(), clap::error::ErrorKind::DisplayVersion);
        assert!(
            err.to_string().contains(VERSION),
            "--version must print {VERSION}, printed: {err}"
        );
        assert_eq!(err.exit_code(), 0, "--version must exit 0");

        let help = Cli::try_parse_from(["retrigger", "--help"])
            .err()
            .expect("--help short-circuits parsing");
        assert_eq!(help.kind(), clap::error::ErrorKind::DisplayHelp);
        assert_eq!(help.exit_code(), 0);
        for subcommand in ["start", "stop", "status", "validate", "config", "benchmark"] {
            assert!(
                help.to_string().contains(subcommand),
                "`{subcommand}` should be listed in --help"
            );
        }
    }

    #[test]
    fn the_flags_the_npm_wrapper_and_docker_pass_are_all_accepted() {
        // Every one of these appears in src/daemon/index.js, bin/retrigger.js, the README, or
        // the container CMD. Breaking one silently breaks an install.
        let invocations: &[&[&str]] = &[
            &["retrigger", "start"],
            &["retrigger", "start", "--foreground"],
            &["retrigger", "start", "--debug"],
            &[
                "retrigger",
                "start",
                "--config",
                "/etc/retrigger/retrigger.toml",
                "--foreground",
            ],
            &["retrigger", "start", "--bind", "0.0.0.0", "--port", "9090"],
            &["retrigger", "start", "-f", "-d", "-p", "1234"],
            &["retrigger", "stop"],
            &["retrigger", "stop", "--force"],
            &["retrigger", "status"],
            &["retrigger", "validate", "--config", "retrigger.toml"],
            &["retrigger", "config", "--output", "retrigger.toml"],
            &["retrigger", "config", "--output", "x.toml", "--force"],
            &["retrigger", "benchmark", "-d", ".", "-f", "10", "-s", "64"],
        ];
        for argv in invocations {
            assert!(
                Cli::try_parse_from(*argv).is_ok(),
                "the CLI must still accept: {argv:?}"
            );
        }
    }

    #[test]
    fn a_zero_file_benchmark_is_rejected_rather_than_dividing_by_zero() {
        for argv in [
            ["retrigger", "benchmark", "--files", "0"],
            ["retrigger", "benchmark", "--size", "0"],
        ] {
            assert!(Cli::try_parse_from(argv).is_err(), "{argv:?}");
        }
    }

    #[test]
    fn an_unknown_subcommand_or_flag_is_rejected() {
        assert!(Cli::try_parse_from(["retrigger", "restart"]).is_err());
        assert!(Cli::try_parse_from(["retrigger", "start", "--daemonize"]).is_err());
        assert!(Cli::try_parse_from(["retrigger"]).is_err());
    }

    #[test]
    fn an_endpoint_needs_a_real_port() {
        let endpoint = Endpoint {
            config: None,
            bind: Some("127.0.0.1".to_owned()),
            port: Some(0),
        };
        let err = endpoint
            .address()
            .expect_err("port 0 is not something a client can connect to");
        assert!(format!("{err:#}").contains("port 0"));
    }

    #[test]
    fn an_endpoint_override_beats_the_default() -> Result<()> {
        let endpoint = Endpoint {
            config: None,
            bind: Some("127.0.0.1".to_owned()),
            port: Some(4321),
        };
        assert_eq!(endpoint.address()?.port(), 4321);
        Ok(())
    }

    #[test]
    fn an_explicitly_named_config_that_is_missing_is_an_error() {
        let err = resolve_config(Some(Path::new("/definitely/not/here.toml")))
            .expect_err("naming a file that is not there must fail");
        assert!(format!("{err:#}").contains("/definitely/not/here.toml"));
    }

    #[test]
    fn durations_read_the_way_a_human_expects() {
        assert_eq!(human_duration(0), "0s");
        assert_eq!(human_duration(59), "59s");
        assert_eq!(human_duration(61), "1m 1s");
        assert_eq!(human_duration(3661), "1h 1m 1s");
        assert_eq!(human_duration(90_061), "1d 1h 1m");
    }
}
