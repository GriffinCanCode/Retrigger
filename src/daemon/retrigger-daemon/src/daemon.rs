//! Core daemon implementation
//! Orchestrates all Retrigger components following the Dependency Inversion Principle

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use retrigger_system::{EnhancedFileEvent, FileEventProcessor, SystemWatcher};
use tokio::sync::broadcast;
use tracing::{debug, error, info, warn};

use crate::config::{CompiledPatterns, ConfigManager, DaemonConfig};
use crate::grpc::GrpcServer;
use crate::ipc::{ZeroCopyConfig, ZeroCopyRing};
use crate::metrics::MetricsCollector;

// Import shutdown signal function
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
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
}

/// Main daemon orchestrator
pub struct Daemon {
    config_manager: ConfigManager,
    system_watcher: Arc<SystemWatcher>,
    event_processor: Arc<FileEventProcessor>,
    grpc_server: Option<GrpcServer>,
    metrics_collector: Arc<MetricsCollector>,

    // Zero-copy IPC system (2025 best practice)
    ipc_ring: Option<Arc<ZeroCopyRing>>,

    // Event channels
    enhanced_event_sender: broadcast::Sender<EnhancedFileEvent>,
    shutdown_sender: broadcast::Sender<()>,
}

impl Daemon {
    /// Create a new daemon instance
    pub async fn new(config_manager: ConfigManager) -> Result<Self> {
        let config = config_manager.get_config().await;

        // Initialize core components
        let system_watcher =
            Arc::new(SystemWatcher::new().with_context(|| "Failed to create system watcher")?);

        // Initialize enhanced event processor with hierarchical caching built-in
        let event_processor = Arc::new(FileEventProcessor::new());
        let metrics_collector = Arc::new(MetricsCollector::new());

        // Initialize zero-copy IPC ring buffer
        let ipc_config = ZeroCopyConfig::default();
        let ipc_ring = match ZeroCopyRing::create_producer(ipc_config) {
            Ok(ring) => Some(Arc::new(ring)),
            Err(e) => {
                warn!(
                    "Failed to create IPC ring buffer: {}, continuing without IPC",
                    e
                );
                None
            }
        };

        // Create event channels
        let (enhanced_event_sender, _) = broadcast::channel(config.watcher.event_buffer_size);
        let (shutdown_sender, _) = broadcast::channel(10);

        // Initialize gRPC server if enabled
        let grpc_server = if config.server.port > 0 {
            Some(
                GrpcServer::new(
                    &config.server.bind_address,
                    config.server.port,
                    Arc::clone(&system_watcher),
                    enhanced_event_sender.clone(),
                )
                .await?,
            )
        } else {
            None
        };

        Ok(Self {
            config_manager,
            system_watcher,
            event_processor,
            grpc_server,
            metrics_collector,
            ipc_ring,
            enhanced_event_sender,
            shutdown_sender,
        })
    }

    /// Run the daemon
    pub async fn run(mut self) -> Result<()> {
        info!("Retrigger daemon starting...");

        let config = self.config_manager.get_config().await;

        // Setup initial watch directories
        for watch_path in &config.watcher.watch_paths {
            if watch_path.enabled {
                self.system_watcher
                    .watch_directory(&watch_path.path, watch_path.recursive)
                    .await
                    .with_context(|| {
                        format!("Failed to watch directory: {}", watch_path.path.display())
                    })?;
            }
        }

        // Start core services
        self.start_event_processor().await?;
        self.start_metrics_collector().await?;
        self.start_config_monitor().await?;
        self.start_cache_maintenance().await?;

        // Start system watcher
        self.system_watcher.start().await?;

        // Start gRPC server
        if let Some(ref mut grpc_server) = self.grpc_server {
            grpc_server.start().await?;
        }

        info!("Retrigger daemon started successfully");

        // Wait for shutdown signal
        let mut shutdown_receiver = self.shutdown_sender.subscribe();

        tokio::select! {
            _ = shutdown_signal() => {
                info!("Received shutdown signal");
            }
            _ = shutdown_receiver.recv() => {
                info!("Received internal shutdown signal");
            }
        }

        // Graceful shutdown
        self.shutdown().await?;

        Ok(())
    }

    /// Start the event processing pipeline
    async fn start_event_processor(&self) -> Result<()> {
        let system_events = self.system_watcher.subscribe();
        let event_processor = Arc::clone(&self.event_processor);
        let enhanced_sender = self.enhanced_event_sender.clone();
        let metrics = Arc::clone(&self.metrics_collector);
        let patterns = self.config_manager.get_patterns().await;
        let ipc_ring = self.ipc_ring.clone();

        tokio::spawn(async move {
            Self::event_processing_loop(
                system_events,
                event_processor,
                enhanced_sender,
                metrics,
                patterns,
                ipc_ring,
            )
            .await;
        });

        info!("Started event processing pipeline");
        Ok(())
    }

    /// Event processing loop with enhanced cache and IPC
    async fn event_processing_loop(
        mut system_events: broadcast::Receiver<retrigger_system::SystemEvent>,
        event_processor: Arc<FileEventProcessor>,
        enhanced_sender: broadcast::Sender<EnhancedFileEvent>,
        metrics: Arc<MetricsCollector>,
        patterns: CompiledPatterns,
        ipc_ring: Option<Arc<ZeroCopyRing>>,
    ) {
        let mut batch = Vec::new();
        let batch_size = 100;
        let batch_timeout = Duration::from_millis(10);

        let mut interval = tokio::time::interval(batch_timeout);

        loop {
            tokio::select! {
                // Collect events into batch
                event_result = system_events.recv() => {
                    match event_result {
                        Ok(event) => {
                            // Check if file should be processed based on patterns
                            if patterns.should_watch(&event.path) {
                                batch.push(event);

                                // Process batch if full
                                if batch.len() >= batch_size {
                                    Self::process_event_batch(
                                        &batch,
                                        &event_processor,
                                        &enhanced_sender,
                                        &metrics,
                                        &ipc_ring,
                                    ).await;
                                    batch.clear();
                                }
                            }
                        }
                        Err(e) => {
                            debug!("Event receiver error: {}", e);
                            break;
                        }
                    }
                }

                // Process batch on timeout
                _ = interval.tick() => {
                    if !batch.is_empty() {
                        Self::process_event_batch(
                            &batch,
                            &event_processor,
                            &enhanced_sender,
                            &metrics,
                            &ipc_ring,
                        ).await;
                        batch.clear();
                    }
                }
            }
        }
    }

    /// Process a batch of events with zero-copy IPC
    async fn process_event_batch(
        events: &[retrigger_system::SystemEvent],
        processor: &FileEventProcessor,
        sender: &broadcast::Sender<EnhancedFileEvent>,
        metrics: &MetricsCollector,
        ipc_ring: &Option<Arc<ZeroCopyRing>>,
    ) {
        let start_time = std::time::Instant::now();

        for event in events {
            match processor.process_event(event.clone()).await {
                Ok(enhanced_event) => {
                    // Send via zero-copy IPC if available
                    if let Some(ring) = ipc_ring.as_ref() {
                        if !ring.push(&enhanced_event) {
                            debug!("IPC ring buffer full, event dropped");
                        }
                    }

                    metrics.record_event(&enhanced_event);

                    if let Err(e) = sender.send(enhanced_event) {
                        debug!("No enhanced event subscribers: {}", e);
                    }
                }
                Err(e) => {
                    warn!(
                        "Failed to process event for {}: {}",
                        event.path.display(),
                        e
                    );
                    metrics.record_error();
                }
            }
        }

        let processing_time = start_time.elapsed();
        metrics.record_batch_processing(events.len(), processing_time);
    }

    /// Start metrics collection
    async fn start_metrics_collector(&self) -> Result<()> {
        let metrics = Arc::clone(&self.metrics_collector);
        let system_watcher = Arc::clone(&self.system_watcher);
        let event_processor = Arc::clone(&self.event_processor);

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(10));

            loop {
                interval.tick().await;

                // Collect system metrics
                let watcher_stats = system_watcher.get_stats().await;
                metrics.update_watcher_stats(&watcher_stats);

                // Collect cache metrics
                let (cache_entries, cache_capacity) = event_processor.cache_stats();
                metrics.update_cache_stats(cache_entries, cache_capacity);

                // Cleanup old cache entries
                event_processor
                    .cleanup_cache(Duration::from_secs(3600))
                    .await;
            }
        });

        info!("Started metrics collection");
        Ok(())
    }

    /// Start configuration monitoring
    async fn start_config_monitor(&self) -> Result<()> {
        let mut config_changes = self.config_manager.subscribe_changes();
        let system_watcher = Arc::clone(&self.system_watcher);

        tokio::spawn(async move {
            while let Ok(new_config) = config_changes.recv().await {
                info!("Configuration changed, applying updates");

                // Apply configuration changes
                if let Err(e) = Self::apply_config_changes(&new_config, &system_watcher).await {
                    error!("Failed to apply configuration changes: {}", e);
                }
            }
        });

        info!("Started configuration monitoring");
        Ok(())
    }

    /// Start cache maintenance (using enhanced FileEventProcessor cache)
    async fn start_cache_maintenance(&self) -> Result<()> {
        let event_processor = Arc::clone(&self.event_processor);

        tokio::spawn(async move {
            let mut cleanup_interval = tokio::time::interval(Duration::from_secs(300)); // 5 minutes

            loop {
                cleanup_interval.tick().await;
                debug!("Running cache cleanup");
                // Use the enhanced cache's built-in cleanup
                event_processor
                    .cleanup_cache(Duration::from_secs(3600))
                    .await;
            }
        });

        info!("Started cache maintenance");
        Ok(())
    }

    /// Apply configuration changes
    async fn apply_config_changes(
        config: &DaemonConfig,
        system_watcher: &SystemWatcher,
    ) -> Result<()> {
        // Update watch directories
        // Note: In a full implementation, this would:
        // 1. Compare old vs new watch paths
        // 2. Add new directories
        // 3. Remove old directories
        // 4. Update recursive settings

        for watch_path in &config.watcher.watch_paths {
            if watch_path.enabled {
                // This is simplified - real implementation would check if already watching
                system_watcher
                    .watch_directory(&watch_path.path, watch_path.recursive)
                    .await?;
            }
        }

        info!("Applied configuration changes");
        Ok(())
    }

    /// Graceful shutdown
    async fn shutdown(self) -> Result<()> {
        info!("Starting graceful shutdown...");

        // Send shutdown signal to all components
        let _ = self.shutdown_sender.send(());

        // Stop gRPC server
        if let Some(grpc_server) = self.grpc_server {
            grpc_server.shutdown().await?;
        }

        // Cleanup would happen in Drop implementations

        info!("Graceful shutdown completed");
        Ok(())
    }

    /// Get daemon statistics
    pub async fn get_stats(&self) -> DaemonStats {
        let watcher_stats = self.system_watcher.get_stats().await;
        let (cache_entries, cache_capacity) = self.event_processor.cache_stats();
        let detailed_cache_stats = self.event_processor.detailed_cache_stats();
        let metrics_stats = self.metrics_collector.get_stats();
        let ipc_stats = self.ipc_ring.as_ref().map(|ring| ring.stats());

        DaemonStats {
            watcher_stats,
            cache_entries,
            cache_capacity,
            detailed_cache_stats,
            ipc_stats,
            uptime_seconds: metrics_stats.uptime_seconds,
            events_processed: metrics_stats.events_processed,
            errors_count: metrics_stats.errors_count,
        }
    }
}

/// Daemon statistics
#[derive(Debug, Clone)]
pub struct DaemonStats {
    pub watcher_stats: retrigger_system::WatcherStats,
    pub cache_entries: usize,
    pub cache_capacity: usize,
    pub detailed_cache_stats: retrigger_system::DetailedCacheStats,
    pub ipc_stats: Option<crate::ipc::RingStats>,
    pub uptime_seconds: u64,
    pub events_processed: u64,
    pub errors_count: u64,
}
