//! Node.js bindings for Retrigger using napi-rs
//! Provides high-performance file watching capabilities to Node.js applications

use std::collections::HashMap;
use std::sync::Arc;

use napi::{bindgen_prelude::*, tokio::sync::broadcast, Result as NapiResult};
use napi_derive::napi;
use retrigger_core::{FastHash, HashEngine};
use retrigger_system::{FileEventProcessor, SystemEvent, SystemEventType, SystemWatcher};
use serde::{Deserialize, Serialize};

/// File event for Node.js
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsFileEvent {
    pub path: String,
    pub event_type: String,
    pub timestamp: String, // Use string for BigInt compatibility
    pub size: String,      // Use string for BigInt compatibility
    pub is_directory: bool,
    pub hash: Option<JsHashResult>,
}

/// Hash result for Node.js
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsHashResult {
    pub hash: String, // Use string for BigInt compatibility
    pub size: u32,
    pub is_incremental: bool,
}

/// Watcher statistics for Node.js
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsWatcherStats {
    pub pending_events: u32,
    pub buffer_capacity: u32,
    pub dropped_events: String, // Use string for BigInt compatibility
    pub total_events: String,   // Use string for BigInt compatibility
    pub watched_directories: u32,
}

/// Watch options for directories
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchOptions {
    pub recursive: Option<bool>,
    pub include_patterns: Option<Vec<String>>,
    pub exclude_patterns: Option<Vec<String>>,
    pub enable_hashing: Option<bool>,
    pub hash_block_size: Option<u32>,
}

impl Default for WatchOptions {
    fn default() -> Self {
        Self {
            recursive: Some(true),
            include_patterns: None,
            exclude_patterns: Some(vec![
                "**/node_modules/**".to_string(),
                "**/.git/**".to_string(),
                "**/.*".to_string(),
            ]),
            enable_hashing: Some(true),
            hash_block_size: Some(4096),
        }
    }
}

/// Main Retrigger wrapper for Node.js
#[napi]
pub struct RetriggerWrapper {
    system_watcher: Arc<SystemWatcher>,
    event_processor: Arc<FileEventProcessor>,
    hash_engine: Arc<HashEngine>,
    event_receiver: Option<broadcast::Receiver<SystemEvent>>,
}

#[napi]
impl RetriggerWrapper {
    /// Create a new Retrigger instance
    #[napi(constructor)]
    pub fn new() -> Self {
        let system_watcher =
            Arc::new(SystemWatcher::new().expect("Failed to create system watcher"));

        let event_processor = Arc::new(FileEventProcessor::new());
        let hash_engine = Arc::new(HashEngine::new());

        Self {
            system_watcher,
            event_processor,
            hash_engine,
            event_receiver: None,
        }
    }

    /// Watch a directory for changes
    #[napi]
    pub async unsafe fn watch_directory(
        &mut self,
        path: String,
        options: Option<WatchOptions>,
    ) -> NapiResult<()> {
        let options = options.unwrap_or_default();
        let recursive = options.recursive.unwrap_or(true);

        self.system_watcher
            .watch_directory(&path, recursive)
            .await
            .map_err(|e| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to watch directory: {}", e),
                )
            })?;

        Ok(())
    }

    /// Start the file watcher
    #[napi]
    pub async unsafe fn start(&mut self) -> NapiResult<()> {
        self.system_watcher.start().await.map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to start watcher: {}", e),
            )
        })?;

        // Subscribe to events
        self.event_receiver = Some(self.system_watcher.subscribe());

        Ok(())
    }

    /// Get the next file event (non-blocking)
    #[napi]
    pub async unsafe fn poll_event(&mut self) -> NapiResult<Option<JsFileEvent>> {
        if let Some(ref mut receiver) = self.event_receiver {
            match receiver.try_recv() {
                Ok(event) => {
                    let enhanced =
                        self.event_processor
                            .process_event(event)
                            .await
                            .map_err(|e| {
                                Error::new(
                                    Status::GenericFailure,
                                    format!("Failed to process event: {}", e),
                                )
                            })?;

                    Ok(Some(convert_to_js_event(enhanced)))
                }
                Err(broadcast::error::TryRecvError::Empty) => Ok(None),
                Err(e) => Err(Error::new(
                    Status::GenericFailure,
                    format!("Event receiver error: {}", e),
                )),
            }
        } else {
            Err(Error::new(Status::InvalidArg, "Watcher not started"))
        }
    }

    /// Wait for the next file event with timeout
    #[napi]
    pub async unsafe fn wait_event(&mut self, timeout_ms: u32) -> NapiResult<Option<JsFileEvent>> {
        if let Some(ref mut receiver) = self.event_receiver {
            let timeout = std::time::Duration::from_millis(timeout_ms as u64);

            match tokio::time::timeout(timeout, receiver.recv()).await {
                Ok(Ok(event)) => {
                    let enhanced =
                        self.event_processor
                            .process_event(event)
                            .await
                            .map_err(|e| {
                                Error::new(
                                    Status::GenericFailure,
                                    format!("Failed to process event: {}", e),
                                )
                            })?;

                    Ok(Some(convert_to_js_event(enhanced)))
                }
                Ok(Err(e)) => Err(Error::new(
                    Status::GenericFailure,
                    format!("Event receiver error: {}", e),
                )),
                Err(_) => Ok(None), // Timeout
            }
        } else {
            Err(Error::new(Status::InvalidArg, "Watcher not started"))
        }
    }

    /// Get watcher statistics
    #[napi]
    pub async fn get_stats(&self) -> NapiResult<JsWatcherStats> {
        let stats = self.system_watcher.get_stats().await;

        Ok(JsWatcherStats {
            pending_events: stats.pending_events,
            buffer_capacity: stats.buffer_capacity,
            dropped_events: stats.dropped_events.to_string(),
            total_events: stats.total_events.to_string(),
            watched_directories: stats.watched_directories as u32,
        })
    }

    /// Hash a file directly
    #[napi]
    pub async fn hash_file(&self, path: String) -> NapiResult<JsHashResult> {
        let engine = HashEngine::new();
        let result = engine.hash_file(&path).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to hash file: {}", e),
            )
        })?;

        Ok(JsHashResult {
            hash: result.hash.to_string(),
            size: result.size,
            is_incremental: result.is_incremental,
        })
    }

    /// Hash bytes directly
    #[napi]
    pub fn hash_bytes(&self, data: Buffer) -> NapiResult<JsHashResult> {
        let engine = HashEngine::new();
        let result = engine.hash_bytes(&data).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to hash bytes: {}", e),
            )
        })?;

        Ok(JsHashResult {
            hash: result.hash.to_string(),
            size: result.size,
            is_incremental: result.is_incremental,
        })
    }

    /// Get SIMD optimization level
    #[napi]
    pub fn get_simd_level(&self) -> String {
        format!("{:?}", HashEngine::detect_simd())
    }
}

/// Convert internal event to JavaScript-friendly event
fn convert_to_js_event(enhanced: retrigger_system::EnhancedFileEvent) -> JsFileEvent {
    let event_type = match enhanced.system_event.event_type {
        SystemEventType::Created => "created",
        SystemEventType::Modified => "modified",
        SystemEventType::Deleted => "deleted",
        SystemEventType::Moved => "moved",
        SystemEventType::MetadataChanged => "metadata_changed",
    };

    let hash = enhanced.hash.map(|h| JsHashResult {
        hash: h.hash.to_string(),
        size: h.size,
        is_incremental: h.is_incremental,
    });

    JsFileEvent {
        path: enhanced.system_event.path.to_string_lossy().to_string(),
        event_type: event_type.to_string(),
        timestamp: enhanced.system_event.timestamp.to_string(),
        size: enhanced.system_event.size.to_string(),
        is_directory: enhanced.system_event.is_directory,
        hash,
    }
}

/// Simplified direct hash function for Node.js
#[napi]
pub fn hash_file_sync(path: String) -> NapiResult<JsHashResult> {
    let engine = HashEngine::new();
    let result = engine.hash_file(&path).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to hash file: {}", e),
        )
    })?;

    Ok(JsHashResult {
        hash: result.hash.to_string(),
        size: result.size,
        is_incremental: result.is_incremental,
    })
}

/// Simplified direct hash function for bytes
#[napi]
pub fn hash_bytes_sync(data: Buffer) -> NapiResult<JsHashResult> {
    let engine = HashEngine::new();
    let result = engine.hash_bytes(&data).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to hash bytes: {}", e),
        )
    })?;

    Ok(JsHashResult {
        hash: result.hash.to_string(),
        size: result.size,
        is_incremental: result.is_incremental,
    })
}

/// Get SIMD capabilities
#[napi]
pub fn get_simd_support() -> String {
    let level = HashEngine::detect_simd();
    format!("{:?}", level)
}

/// Run performance benchmark
#[napi]
pub async fn benchmark_hash(test_size: u32) -> NapiResult<HashMap<String, f64>> {
    let engine = HashEngine::new();

    // Simple benchmark - just hash some test data and measure time
    let data: Vec<u8> = (0..test_size).map(|i| (i * 0x9E3779B1) as u8).collect();

    let start = std::time::Instant::now();
    let _ = engine
        .hash_bytes(&data)
        .map_err(|e| Error::new(Status::GenericFailure, format!("Benchmark failed: {}", e)))?;
    let elapsed = start.elapsed();

    let throughput_mbps = (test_size as f64) / (1024.0 * 1024.0) / elapsed.as_secs_f64();
    let latency_ns = elapsed.as_nanos() as f64;

    let mut stats = HashMap::new();
    stats.insert("throughput_mbps".to_string(), throughput_mbps);
    stats.insert("latency_ns".to_string(), latency_ns);

    Ok(stats)
}
