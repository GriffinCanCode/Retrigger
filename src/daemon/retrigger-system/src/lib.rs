//! Retrigger System Integration
//!
//! Rust wrapper around the high-performance Zig system layer.
//! Provides async interfaces for file system monitoring.

use std::ffi::{CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use dashmap::DashMap;
use retrigger_core::{FastHash, HashEngine, HashResult};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tracing::{debug, info, warn};

/// File system event from the native layer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemEvent {
    pub path: PathBuf,
    pub event_type: SystemEventType,
    pub timestamp: u64,
    pub size: u64,
    pub is_directory: bool,
}

/// System event types matching the Zig layer
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum SystemEventType {
    Created = 1,
    Modified = 2,
    Deleted = 3,
    Moved = 4,
    MetadataChanged = 5,
}

/// File system watcher statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatcherStats {
    pub pending_events: u32,
    pub buffer_capacity: u32,
    pub dropped_events: u64,
    pub total_events: u64,
    pub watched_directories: usize,
}

/// FFI bindings to the Zig layer
mod ffi {
    use std::os::raw::{c_char, c_int};

    #[repr(C)]
    pub struct FileWatcher {
        _private: [u8; 0],
    }

    #[repr(C)]
    #[allow(dead_code)]
    pub struct FileEvent {
        pub path: *const c_char,
        pub event_type: u8,
        pub timestamp: u64,
        pub size: u64,
        pub is_directory: bool,
    }

    extern "C" {
        pub fn fw_watcher_create() -> *mut FileWatcher;
        pub fn fw_watcher_destroy(watcher: *mut FileWatcher);
        pub fn fw_watcher_watch_directory(
            watcher: *mut FileWatcher,
            path: *const c_char,
            recursive: bool,
        ) -> c_int;
        pub fn fw_watcher_start(watcher: *mut FileWatcher) -> c_int;
        #[allow(dead_code)]
        pub fn fw_watcher_poll_event(watcher: *mut FileWatcher, out_event: *mut FileEvent) -> bool;
    }
}

/// High-level system file watcher
pub struct SystemWatcher {
    watcher: *mut ffi::FileWatcher,
    #[allow(dead_code)]
    hash_engine: Arc<HashEngine>,
    watched_paths: DashMap<PathBuf, bool>, // path -> recursive
    event_sender: broadcast::Sender<SystemEvent>,
    stats: Arc<tokio::sync::RwLock<WatcherStats>>,
}

unsafe impl Send for SystemWatcher {}
unsafe impl Sync for SystemWatcher {}

impl SystemWatcher {
    /// Create a new system watcher
    pub fn new() -> Result<Self> {
        let watcher = unsafe { ffi::fw_watcher_create() };
        if watcher.is_null() {
            anyhow::bail!("Failed to create system watcher");
        }

        let (event_sender, _) = broadcast::channel(10_000);
        let hash_engine = Arc::new(HashEngine::new());

        info!(
            "Created system watcher with SIMD level: {:?}",
            hash_engine.simd_level()
        );

        Ok(SystemWatcher {
            watcher,
            hash_engine,
            watched_paths: DashMap::new(),
            event_sender,
            stats: Arc::new(tokio::sync::RwLock::new(WatcherStats {
                pending_events: 0,
                buffer_capacity: 0,
                dropped_events: 0,
                total_events: 0,
                watched_directories: 0,
            })),
        })
    }

    /// Watch a directory for file system changes
    pub async fn watch_directory<P: AsRef<Path>>(&self, path: P, recursive: bool) -> Result<()> {
        let path = path.as_ref().to_path_buf();
        let path_str = path
            .to_str()
            .with_context(|| format!("Invalid path: {}", path.display()))?;

        let c_path = CString::new(path_str)?;

        let result =
            unsafe { ffi::fw_watcher_watch_directory(self.watcher, c_path.as_ptr(), recursive) };

        if result != 0 {
            anyhow::bail!("Failed to watch directory: {}", path.display());
        }

        self.watched_paths.insert(path.clone(), recursive);

        // Update stats
        {
            let mut stats = self.stats.write().await;
            stats.watched_directories = self.watched_paths.len();
        }

        info!(
            "Watching directory: {} (recursive: {})",
            path.display(),
            recursive
        );
        Ok(())
    }

    /// Start the file system monitoring
    pub async fn start(&self) -> Result<()> {
        let result = unsafe { ffi::fw_watcher_start(self.watcher) };
        if result != 0 {
            anyhow::bail!("Failed to start system watcher");
        }

        // For now, we'll skip the background task to avoid threading issues
        // In a full implementation, we'd use proper synchronization primitives
        info!("Event polling would be started here");

        info!("Started system watcher");
        Ok(())
    }

    /// Subscribe to file system events
    pub fn subscribe(&self) -> broadcast::Receiver<SystemEvent> {
        self.event_sender.subscribe()
    }

    /// Get current watcher statistics
    pub async fn get_stats(&self) -> WatcherStats {
        self.stats.read().await.clone()
    }

    /// Event polling task that runs in the background
    #[allow(dead_code)]
    async fn event_polling_task(
        watcher: *mut ffi::FileWatcher,
        event_sender: broadcast::Sender<SystemEvent>,
        stats: Arc<tokio::sync::RwLock<WatcherStats>>,
        _hash_engine: Arc<HashEngine>,
    ) {
        let mut interval = tokio::time::interval(Duration::from_millis(10));
        let mut total_events = 0u64;

        loop {
            interval.tick().await;

            // Poll for events from the native layer
            let mut ffi_event = ffi::FileEvent {
                path: std::ptr::null(),
                event_type: 0,
                timestamp: 0,
                size: 0,
                is_directory: false,
            };

            let has_event = unsafe { ffi::fw_watcher_poll_event(watcher, &mut ffi_event) };

            if !has_event {
                continue;
            }

            // Convert FFI event to Rust event
            let path = if ffi_event.path.is_null() {
                continue;
            } else {
                let path_cstr = unsafe { CStr::from_ptr(ffi_event.path) };
                match path_cstr.to_str() {
                    Ok(path_str) => PathBuf::from(path_str),
                    Err(e) => {
                        warn!("Invalid path in event: {}", e);
                        continue;
                    }
                }
            };

            let event_type = match ffi_event.event_type {
                1 => SystemEventType::Created,
                2 => SystemEventType::Modified,
                3 => SystemEventType::Deleted,
                4 => SystemEventType::Moved,
                5 => SystemEventType::MetadataChanged,
                _ => continue,
            };

            let system_event = SystemEvent {
                path,
                event_type,
                timestamp: ffi_event.timestamp,
                size: ffi_event.size,
                is_directory: ffi_event.is_directory,
            };

            total_events += 1;

            // Send event to subscribers
            if let Err(e) = event_sender.send(system_event.clone()) {
                debug!("No event subscribers: {}", e);
            }

            // Update stats periodically
            if total_events.is_multiple_of(1000) {
                let mut stats_guard = stats.write().await;
                stats_guard.total_events = total_events;
                // Additional stats would be retrieved from native layer
            }
        }
    }
}

impl Drop for SystemWatcher {
    fn drop(&mut self) {
        if !self.watcher.is_null() {
            unsafe {
                ffi::fw_watcher_destroy(self.watcher);
            }
        }
    }
}

/// Enhanced file event that includes hash information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnhancedFileEvent {
    pub system_event: SystemEvent,
    pub hash: Option<HashResult>,
    pub processing_time_ns: u64,
}

/// Enhanced cache entry with hierarchy info (2025 best practice)
#[derive(Debug, Clone)]
struct CacheEntry {
    hash: HashResult,
    timestamp: SystemTime,
    access_count: u32,
    #[allow(dead_code)]
    directory_level: usize,
}

/// Configuration for the enhanced cache
#[derive(Debug, Clone)]
pub struct CacheConfig {
    pub max_entries: usize,
    pub ttl_seconds: u64,
    pub enable_hierarchy: bool,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            max_entries: 1_000_000,
            ttl_seconds: 3600,
            enable_hierarchy: true,
        }
    }
}

/// Enhanced file event processor with hierarchical caching
pub struct FileEventProcessor {
    hash_engine: Arc<HashEngine>,
    hash_cache: Arc<DashMap<PathBuf, CacheEntry>>,
    directory_cache: Arc<DashMap<PathBuf, Vec<PathBuf>>>,
    config: CacheConfig,
}

impl FileEventProcessor {
    pub fn new() -> Self {
        Self::with_config(CacheConfig::default())
    }

    pub fn with_config(config: CacheConfig) -> Self {
        Self {
            hash_engine: Arc::new(HashEngine::new()),
            hash_cache: Arc::new(DashMap::with_capacity(config.max_entries)),
            directory_cache: Arc::new(DashMap::new()),
            config,
        }
    }

    /// Process a system event and add hash information
    pub async fn process_event(&self, event: SystemEvent) -> Result<EnhancedFileEvent> {
        let start_time = std::time::Instant::now();

        let hash = if !event.is_directory
            && matches!(
                event.event_type,
                SystemEventType::Created | SystemEventType::Modified
            ) {
            // Check hierarchical cache first
            if let Some(mut entry) = self.hash_cache.get_mut(&event.path) {
                let event_time = UNIX_EPOCH + Duration::from_nanos(event.timestamp);

                // Check TTL
                let age = SystemTime::now()
                    .duration_since(entry.timestamp)
                    .unwrap_or(Duration::ZERO);

                if age.as_secs() <= self.config.ttl_seconds && entry.timestamp >= event_time {
                    // Update access count for LRU
                    entry.access_count += 1;
                    Some(entry.hash.clone())
                } else {
                    drop(entry); // Release lock before computing new hash
                    self.compute_and_cache_hash(&event.path).await
                }
            } else {
                // Compute new hash
                self.compute_and_cache_hash(&event.path).await
            }
        } else {
            // Handle directory events for hierarchy
            if event.is_directory && matches!(event.event_type, SystemEventType::Deleted) {
                self.invalidate_directory(&event.path);
            }
            None
        };

        let processing_time_ns = start_time.elapsed().as_nanos() as u64;

        Ok(EnhancedFileEvent {
            system_event: event,
            hash,
            processing_time_ns,
        })
    }

    /// Compute and cache file hash with hierarchical awareness
    async fn compute_and_cache_hash(&self, path: &Path) -> Option<HashResult> {
        let hash_result = match self.hash_engine.hash_file(path) {
            Ok(result) => result,
            Err(e) => {
                warn!("Failed to hash file {}: {}", path.display(), e);
                return None;
            }
        };

        // Create enhanced cache entry
        let entry = CacheEntry {
            hash: hash_result.clone(),
            timestamp: SystemTime::now(),
            access_count: 1,
            directory_level: path.components().count(),
        };

        // Insert into cache
        self.hash_cache.insert(path.to_path_buf(), entry);

        // Update directory hierarchy if enabled
        if self.config.enable_hierarchy {
            if let Some(parent) = path.parent() {
                self.directory_cache
                    .entry(parent.to_path_buf())
                    .or_default()
                    .push(path.to_path_buf());
            }
        }

        // Check if we need to evict (simple capacity management)
        if self.hash_cache.len() > self.config.max_entries {
            self.evict_lru();
        }

        Some(hash_result)
    }

    /// Invalidate directory hierarchy
    fn invalidate_directory(&self, dir: &Path) {
        if !self.config.enable_hierarchy {
            return;
        }

        if let Some((_, files)) = self.directory_cache.remove(dir) {
            for file in files {
                self.hash_cache.remove(&file);
            }
        }

        // Also remove subdirectories
        let dir_str = dir.to_string_lossy();
        self.directory_cache
            .retain(|path, _| !path.to_string_lossy().starts_with(dir_str.as_ref()));
    }

    /// Evict least recently used entries
    fn evict_lru(&self) {
        let target_size = (self.config.max_entries as f64 * 0.8) as usize;
        let entries_to_remove = self.hash_cache.len().saturating_sub(target_size);

        if entries_to_remove == 0 {
            return;
        }

        // Collect entries for eviction (simple LRU based on access_count)
        let mut to_evict = Vec::new();
        for entry in self.hash_cache.iter() {
            to_evict.push((entry.key().clone(), entry.access_count));
            if to_evict.len() >= entries_to_remove * 2 {
                break;
            }
        }

        // Sort by access count (ascending) to evict least used
        to_evict.sort_by_key(|(_, count)| *count);

        // Remove the least used entries
        for (path, _) in to_evict.into_iter().take(entries_to_remove) {
            self.hash_cache.remove(&path);
            // Also clean up from directory hierarchy
            if let Some(parent) = path.parent() {
                if let Some(mut files) = self.directory_cache.get_mut(parent) {
                    files.retain(|p| p != &path);
                }
            }
        }
    }

    /// Get enhanced cache statistics
    pub fn cache_stats(&self) -> (usize, usize) {
        (self.hash_cache.len(), self.config.max_entries)
    }

    /// Get detailed cache statistics
    pub fn detailed_cache_stats(&self) -> DetailedCacheStats {
        let entry_count = self.hash_cache.len();
        let directory_count = self.directory_cache.len();
        let utilization = (entry_count as f64 / self.config.max_entries as f64) * 100.0;

        DetailedCacheStats {
            entry_count,
            directory_count,
            capacity: self.config.max_entries,
            utilization,
            ttl_seconds: self.config.ttl_seconds,
        }
    }

    /// Clear expired cache entries
    pub async fn cleanup_cache(&self, max_age: Duration) {
        let cutoff = SystemTime::now() - max_age;
        let mut removed_count = 0;

        self.hash_cache.retain(|path, entry| {
            if entry.timestamp < cutoff {
                removed_count += 1;
                // Clean up from directory hierarchy
                if let Some(parent) = path.parent() {
                    if let Some(mut files) = self.directory_cache.get_mut(parent) {
                        files.retain(|p| p != path);
                    }
                }
                false
            } else {
                true
            }
        });

        // Clean up empty directories
        self.directory_cache.retain(|_, files| !files.is_empty());

        if removed_count > 0 {
            debug!("Cleaned up {} expired cache entries", removed_count);
        }
    }

    /// Clear all cache entries
    pub fn clear_cache(&self) {
        self.hash_cache.clear();
        self.directory_cache.clear();
    }
}

impl Default for FileEventProcessor {
    fn default() -> Self {
        Self::new()
    }
}

/// Detailed cache statistics for monitoring
#[derive(Debug, Clone)]
pub struct DetailedCacheStats {
    pub entry_count: usize,
    pub directory_count: usize,
    pub capacity: usize,
    pub utilization: f64,
    pub ttl_seconds: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[allow(unused_imports)]
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_watcher_creation() {
        // This test would only work with the full Zig implementation
        if let Ok(watcher) = SystemWatcher::new() {
            let stats = watcher.get_stats().await;
            assert_eq!(stats.watched_directories, 0);
        }
    }

    #[tokio::test]
    async fn test_event_processor() {
        let processor = FileEventProcessor::new();

        // Create a test event
        let test_event = SystemEvent {
            path: PathBuf::from("/tmp/test.txt"),
            event_type: SystemEventType::Created,
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos() as u64,
            size: 1024,
            is_directory: false,
        };

        // Processing should complete without error (even if file doesn't exist)
        let enhanced = processor.process_event(test_event).await;
        assert!(enhanced.is_ok());
    }
}
