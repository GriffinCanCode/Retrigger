//! Retrigger Daemon - High-performance file watching service
//!
//! A native daemon that provides ultra-fast file system monitoring
//! with sub-millisecond latency for development tooling.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use metrics_exporter_prometheus::PrometheusBuilder;
use retrigger_system::{FileEventProcessor, SystemWatcher};
use tokio::signal;
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod api;
mod config;
mod daemon;
mod grpc;
mod ipc; // Zero-copy IPC module
mod metrics; // Zero-copy public APIs

use config::{ConfigManager, DaemonConfig};
use daemon::Daemon;

/// Retrigger - High-performance file system watcher
#[derive(Parser)]
#[command(name = "retrigger")]
#[command(about = "A high-performance file system watcher daemon")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the daemon
    Start(StartArgs),
    /// Stop the daemon
    Stop(StopArgs),
    /// Check daemon status
    Status,
    /// Validate configuration
    Validate(ValidateArgs),
    /// Generate default configuration
    Config(ConfigArgs),
    /// Run benchmarks
    Benchmark(BenchmarkArgs),
}

#[derive(Args)]
struct StartArgs {
    /// Configuration file path
    #[arg(short, long, default_value = "retrigger.toml")]
    config: PathBuf,

    /// Run in foreground (don't daemonize)
    #[arg(short, long)]
    foreground: bool,

    /// Enable debug logging
    #[arg(short, long)]
    debug: bool,

    /// Override bind address
    #[arg(long)]
    bind: Option<String>,

    /// Override port
    #[arg(short, long)]
    port: Option<u16>,
}

#[derive(Args)]
struct StopArgs {
    /// Force stop (SIGKILL)
    #[arg(short, long)]
    force: bool,
}

#[derive(Args)]
struct ValidateArgs {
    /// Configuration file to validate
    #[arg(short, long, default_value = "retrigger.toml")]
    config: PathBuf,
}

#[derive(Args)]
struct ConfigArgs {
    /// Output file for generated config
    #[arg(short, long, default_value = "retrigger.toml")]
    output: PathBuf,

    /// Overwrite existing file
    #[arg(long)]
    force: bool,
}

#[derive(Args)]
struct BenchmarkArgs {
    /// Test directory for benchmarks
    #[arg(short, long, default_value = ".")]
    directory: PathBuf,

    /// Number of files to create for testing
    #[arg(short, long, default_value = "1000")]
    files: usize,

    /// File size in bytes
    #[arg(short, long, default_value = "1024")]
    size: usize,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Start(args) => start_daemon(args).await,
        Commands::Stop(args) => stop_daemon(args).await,
        Commands::Status => show_status().await,
        Commands::Validate(args) => validate_config(args).await,
        Commands::Config(args) => generate_config(args).await,
        Commands::Benchmark(args) => run_benchmark(args).await,
    }
}

/// Start the Retrigger daemon
async fn start_daemon(args: StartArgs) -> Result<()> {
    // Initialize tracing
    init_tracing(&args)?;

    info!("Starting Retrigger daemon v{}", env!("CARGO_PKG_VERSION"));

    // Load configuration
    let mut config_manager = ConfigManager::new();

    if args.config.exists() {
        config_manager
            .load_from_file(&args.config)
            .await
            .with_context(|| "Failed to load configuration")?;
    } else {
        warn!("Configuration file not found, using defaults");
    }

    let mut config = config_manager.get_config().await;

    // Apply CLI overrides
    if let Some(bind) = args.bind {
        config.server.bind_address = bind;
    }
    if let Some(port) = args.port {
        config.server.port = port;
    }

    // Validate configuration
    ConfigManager::validate(&config)?;

    // Start hot-reload if config file exists
    // TEMPORARY: Disable hot-reload to debug startup hang
    // if args.config.exists() {
    //     config_manager.start_hot_reload().await?;
    // }

    // Initialize metrics
    if config.server.enable_metrics {
        init_metrics(&config).await?;
    }

    // Create and start daemon
    let daemon = Daemon::new(config_manager).await?;

    if args.foreground {
        // Run in foreground
        daemon.run().await?;
    } else {
        // Daemonize (simplified - real implementation would use proper daemonization)
        info!("Starting daemon in background mode");
        daemon.run().await?;
    }

    Ok(())
}

/// Stop the daemon
async fn stop_daemon(args: StopArgs) -> Result<()> {
    info!("Stopping Retrigger daemon");

    // In a real implementation, this would:
    // 1. Read PID from lock file
    // 2. Send SIGTERM (or SIGKILL if force)
    // 3. Wait for graceful shutdown

    if args.force {
        info!("Force stopping daemon");
    } else {
        info!("Gracefully stopping daemon");
    }

    Ok(())
}

/// Show daemon status
async fn show_status() -> Result<()> {
    println!("Retrigger Daemon Status");
    println!("======================");

    // In a real implementation, this would check:
    // 1. PID file existence
    // 2. Process status
    // 3. gRPC endpoint health
    // 4. Current statistics

    println!("Status: Not implemented in this example");
    Ok(())
}

/// Validate configuration file
async fn validate_config(args: ValidateArgs) -> Result<()> {
    info!("Validating configuration: {}", args.config.display());

    let mut config_manager = ConfigManager::new();
    config_manager.load_from_file(&args.config).await?;

    let config = config_manager.get_config().await;
    ConfigManager::validate(&config)?;

    println!("✓ Configuration is valid");
    Ok(())
}

/// Generate default configuration file
async fn generate_config(args: ConfigArgs) -> Result<()> {
    if args.output.exists() && !args.force {
        anyhow::bail!(
            "Configuration file already exists: {}",
            args.output.display()
        );
    }

    let _config = DaemonConfig::default();
    let config_manager = ConfigManager::new();
    config_manager.save_to_file(&args.output).await?;

    info!("Generated configuration file: {}", args.output.display());
    Ok(())
}

/// Run performance benchmarks
async fn run_benchmark(args: BenchmarkArgs) -> Result<()> {
    info!("Running Retrigger benchmarks");
    info!("Directory: {}", args.directory.display());
    info!("Files: {}, Size: {} bytes", args.files, args.size);

    // Create benchmark environment
    let temp_dir = tempfile::tempdir()?;

    // Initialize system watcher
    let watcher = SystemWatcher::new()?;
    let processor = FileEventProcessor::new();

    // Start watching
    watcher.watch_directory(&temp_dir.path(), true).await?;
    watcher.start().await?;

    // Subscribe to events
    let mut event_receiver = watcher.subscribe();

    // Performance measurement
    let start_time = std::time::Instant::now();
    let mut events_received = 0;

    // Create test files
    info!("Creating {} test files...", args.files);
    let file_creation_start = std::time::Instant::now();

    for i in 0..args.files {
        let file_path = temp_dir.path().join(format!("test_file_{i}.txt"));
        let content = vec![b'A'; args.size];
        tokio::fs::write(file_path, content).await?;

        if i % 100 == 0 {
            info!("Created {} files", i + 1);
        }
    }

    let file_creation_time = file_creation_start.elapsed();
    info!("File creation took: {:?}", file_creation_time);

    // Wait for events with timeout
    let event_timeout = Duration::from_secs(30);
    let event_start = std::time::Instant::now();

    tokio::select! {
        _ = tokio::time::sleep(event_timeout) => {
            warn!("Event collection timeout reached");
        }
        _ = async {
            while events_received < args.files {
                if let Ok(event) = event_receiver.recv().await {
                    let _enhanced = processor.process_event(event).await?;
                    events_received += 1;

                    if events_received % 100 == 0 {
                        info!("Received {} events", events_received);
                    }
                }
            }
            Ok::<(), anyhow::Error>(())
        } => {}
    }

    let total_time = start_time.elapsed();
    let event_time = event_start.elapsed();

    // Calculate statistics
    println!("\nBenchmark Results");
    println!("=================");
    println!("Files created: {}", args.files);
    println!("Events received: {events_received}");
    println!("File creation time: {file_creation_time:?}");
    println!("Event processing time: {event_time:?}");
    println!("Total time: {total_time:?}");
    println!(
        "Events/sec: {:.2}",
        events_received as f64 / event_time.as_secs_f64()
    );
    println!(
        "Avg latency per event: {:?}",
        event_time / events_received as u32
    );

    // Get cache statistics
    let (cache_entries, cache_capacity) = processor.cache_stats();
    println!(
        "Hash cache utilization: {}/{} ({:.1}%)",
        cache_entries,
        cache_capacity,
        (cache_entries as f64 / cache_capacity as f64) * 100.0
    );

    // Get watcher statistics
    let stats = watcher.get_stats().await;
    println!("Watcher stats: {stats:?}");

    Ok(())
}

/// Initialize tracing/logging
fn init_tracing(args: &StartArgs) -> Result<()> {
    let level = if args.debug { "debug" } else { "info" };

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(level));

    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer())
        .init();

    Ok(())
}

/// Initialize Prometheus metrics
async fn init_metrics(config: &DaemonConfig) -> Result<()> {
    let builder = PrometheusBuilder::new();
    builder
        .with_http_listener(([0, 0, 0, 0], config.server.metrics_port))
        .install()?;

    // Metrics are auto-registered when first used
    // Initial setup complete - metrics will be created on first use

    info!(
        "Metrics endpoint started on port {}",
        config.server.metrics_port
    );
    Ok(())
}

/// Handle graceful shutdown
pub async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    info!("Shutdown signal received, starting graceful shutdown");
}
