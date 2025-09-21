//! Metrics collection and reporting
//! Follows SRP: Only responsible for metrics collection and export

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use metrics::{counter, gauge, histogram};
use retrigger_system::{EnhancedFileEvent, WatcherStats};

/// Metrics collector for daemon statistics
pub struct MetricsCollector {
    start_time: Instant,
    events_processed: AtomicU64,
    errors_count: AtomicU64,
    total_processing_time_ns: AtomicU64,
}

impl MetricsCollector {
    /// Create a new metrics collector
    pub fn new() -> Self {
        Self {
            start_time: Instant::now(),
            events_processed: AtomicU64::new(0),
            errors_count: AtomicU64::new(0),
            total_processing_time_ns: AtomicU64::new(0),
        }
    }

    /// Record a processed file event
    pub fn record_event(&self, event: &EnhancedFileEvent) {
        // Increment counters
        counter!("retrigger_events_total").increment(1);
        self.events_processed.fetch_add(1, Ordering::Relaxed);

        // Record processing time
        histogram!("retrigger_event_processing_duration").record(event.processing_time_ns as f64);
        self.total_processing_time_ns
            .fetch_add(event.processing_time_ns, Ordering::Relaxed);

        // Record event type specific metrics
        let event_type = match event.system_event.event_type {
            retrigger_system::SystemEventType::Created => "created",
            retrigger_system::SystemEventType::Modified => "modified",
            retrigger_system::SystemEventType::Deleted => "deleted",
            retrigger_system::SystemEventType::Moved => "moved",
            retrigger_system::SystemEventType::MetadataChanged => "metadata_changed",
        };
        counter!("retrigger_events_by_type_total", "type" => event_type).increment(1);

        // Record file size metrics
        if !event.system_event.is_directory {
            histogram!("retrigger_file_size_bytes").record(event.system_event.size as f64);
        }

        // Record hash metrics if available
        if let Some(ref hash) = event.hash {
            counter!("retrigger_files_hashed_total").increment(1);
            gauge!("retrigger_last_hash_size").set(hash.size as f64);

            if hash.is_incremental {
                counter!("retrigger_incremental_hashes_total").increment(1);
            }
        }
    }

    /// Record an error
    pub fn record_error(&self) {
        counter!("retrigger_errors_total").increment(1);
        self.errors_count.fetch_add(1, Ordering::Relaxed);
    }

    /// Record batch processing metrics
    pub fn record_batch_processing(&self, batch_size: usize, processing_time: Duration) {
        histogram!("retrigger_batch_processing_duration").record(processing_time.as_nanos() as f64);
        histogram!("retrigger_batch_size").record(batch_size as f64);

        // Calculate batch throughput
        let throughput = batch_size as f64 / processing_time.as_secs_f64();
        histogram!("retrigger_batch_throughput").record(throughput);
    }

    /// Update watcher statistics
    pub fn update_watcher_stats(&self, stats: &WatcherStats) {
        gauge!("retrigger_pending_events").set(stats.pending_events as f64);
        gauge!("retrigger_buffer_capacity").set(stats.buffer_capacity as f64);
        gauge!("retrigger_dropped_events").set(stats.dropped_events as f64);
        gauge!("retrigger_watched_directories").set(stats.watched_directories as f64);

        // Calculate buffer utilization percentage
        let utilization = if stats.buffer_capacity > 0 {
            (stats.pending_events as f64 / stats.buffer_capacity as f64) * 100.0
        } else {
            0.0
        };
        gauge!("retrigger_buffer_utilization_percent").set(utilization);
    }

    /// Update hash cache statistics
    pub fn update_cache_stats(&self, entries: usize, capacity: usize) {
        gauge!("retrigger_hash_cache_entries").set(entries as f64);
        gauge!("retrigger_hash_cache_capacity").set(capacity as f64);

        // Calculate cache utilization percentage
        let utilization = if capacity > 0 {
            (entries as f64 / capacity as f64) * 100.0
        } else {
            0.0
        };
        gauge!("retrigger_hash_cache_utilization_percent").set(utilization);
    }

    /// Get current statistics
    pub fn get_stats(&self) -> MetricsStats {
        MetricsStats {
            uptime_seconds: self.start_time.elapsed().as_secs(),
            events_processed: self.events_processed.load(Ordering::Relaxed),
            errors_count: self.errors_count.load(Ordering::Relaxed),
            total_processing_time_ns: self.total_processing_time_ns.load(Ordering::Relaxed),
        }
    }

    /// Calculate average processing time
    pub fn average_processing_time_ns(&self) -> u64 {
        let events = self.events_processed.load(Ordering::Relaxed);
        let total_time = self.total_processing_time_ns.load(Ordering::Relaxed);

        if events > 0 {
            total_time / events
        } else {
            0
        }
    }

    /// Calculate events per second
    pub fn events_per_second(&self) -> f64 {
        let events = self.events_processed.load(Ordering::Relaxed);
        let uptime = self.start_time.elapsed().as_secs_f64();

        if uptime > 0.0 {
            events as f64 / uptime
        } else {
            0.0
        }
    }
}

impl Default for MetricsCollector {
    fn default() -> Self {
        Self::new()
    }
}

/// Metrics statistics snapshot
#[derive(Debug, Clone)]
pub struct MetricsStats {
    pub uptime_seconds: u64,
    pub events_processed: u64,
    pub errors_count: u64,
    pub total_processing_time_ns: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use retrigger_system::{SystemEvent, SystemEventType};
    use std::path::PathBuf;

    #[test]
    fn test_metrics_collector() {
        let collector = MetricsCollector::new();

        // Create test event
        let system_event = SystemEvent {
            path: PathBuf::from("/test/file.txt"),
            event_type: SystemEventType::Created,
            timestamp: 1234567890,
            size: 1024,
            is_directory: false,
        };

        let enhanced_event = EnhancedFileEvent {
            system_event,
            hash: None,
            processing_time_ns: 1_000_000, // 1ms
        };

        // Record event
        collector.record_event(&enhanced_event);

        let stats = collector.get_stats();
        assert_eq!(stats.events_processed, 1);
        assert_eq!(stats.total_processing_time_ns, 1_000_000);
    }

    #[test]
    fn test_average_processing_time() {
        let collector = MetricsCollector::new();

        // Record multiple events
        for i in 0..10 {
            let system_event = SystemEvent {
                path: PathBuf::from(format!("/test/file{}.txt", i)),
                event_type: SystemEventType::Modified,
                timestamp: 1234567890 + i as u64,
                size: 1024,
                is_directory: false,
            };

            let enhanced_event = EnhancedFileEvent {
                system_event,
                hash: None,
                processing_time_ns: (i + 1) * 1_000_000, // Variable processing time
            };

            collector.record_event(&enhanced_event);
        }

        // Average should be (1+2+...+10)/10 * 1_000_000 = 5.5 * 1_000_000
        let avg = collector.average_processing_time_ns();
        assert_eq!(avg, 5_500_000);
    }
}
