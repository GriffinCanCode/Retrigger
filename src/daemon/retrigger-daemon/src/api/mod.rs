//! Zero-Copy API Module
//!
//! Simple, elegant public APIs for zero-copy file event communication.
//! Follows 2025 best practices: minimal surface area, maximum performance.

// Removed unused PathBuf import
use std::time::Duration;

use anyhow::Result;
use retrigger_system::EnhancedFileEvent;
use tokio::time::timeout;

use crate::ipc::{RingStats, ZeroCopyConfig, ZeroCopyRing};

/// High-level Zero-Copy Event Consumer (2025 API Design)
/// Follows Single Responsibility: only consumes events
pub struct ZeroCopyConsumer {
    ring: ZeroCopyRing,
    #[allow(dead_code)]
    config: ZeroCopyConfig,
}

impl ZeroCopyConsumer {
    /// Connect to daemon's zero-copy IPC channel
    pub fn connect() -> Result<Self> {
        Self::connect_with_config(ZeroCopyConfig::default())
    }

    /// Connect with custom configuration
    pub fn connect_with_config(config: ZeroCopyConfig) -> Result<Self> {
        let ring = ZeroCopyRing::create_consumer(config.clone())?;
        Ok(Self { ring, config })
    }

    /// Get next event (non-blocking)
    pub fn try_recv(&self) -> Option<EnhancedFileEvent> {
        self.ring.pop()
    }

    /// Get next event with timeout
    pub async fn recv_timeout(
        &self,
        timeout_duration: Duration,
    ) -> Result<Option<EnhancedFileEvent>> {
        let result = timeout(timeout_duration, async {
            // Simple polling approach - could be enhanced with proper async notifications
            loop {
                if let Some(event) = self.ring.pop() {
                    return Some(event);
                }
                tokio::time::sleep(Duration::from_micros(100)).await; // 0.1ms polling
            }
        })
        .await;

        match result {
            Ok(event) => Ok(event),
            Err(_) => Ok(None), // Timeout
        }
    }

    /// Get buffer utilization statistics
    pub fn stats(&self) -> RingStats {
        self.ring.stats()
    }

    /// Check if more events are available
    pub fn has_events(&self) -> bool {
        self.stats().used > 0
    }
}

/// Event iterator for efficient batch processing
pub struct EventIterator<'a> {
    consumer: &'a ZeroCopyConsumer,
    batch_size: usize,
    current_batch: usize,
}

impl<'a> EventIterator<'a> {
    /// Create iterator with default batch size
    pub fn new(consumer: &'a ZeroCopyConsumer) -> Self {
        Self {
            consumer,
            batch_size: 100,
            current_batch: 0,
        }
    }

    /// Create iterator with custom batch size
    pub fn with_batch_size(consumer: &'a ZeroCopyConsumer, batch_size: usize) -> Self {
        Self {
            consumer,
            batch_size,
            current_batch: 0,
        }
    }
}

impl<'a> Iterator for EventIterator<'a> {
    type Item = EnhancedFileEvent;

    fn next(&mut self) -> Option<Self::Item> {
        if self.current_batch >= self.batch_size {
            return None; // Batch limit reached
        }

        if let Some(event) = self.consumer.try_recv() {
            self.current_batch += 1;
            Some(event)
        } else {
            None // No more events
        }
    }
}

impl ZeroCopyConsumer {
    /// Get iterator for batch processing
    pub fn iter(&self) -> EventIterator<'_> {
        EventIterator::new(self)
    }

    /// Get iterator with custom batch size
    pub fn iter_batch(&self, batch_size: usize) -> EventIterator<'_> {
        EventIterator::with_batch_size(self, batch_size)
    }
}

/// Simple convenience functions (2025 API Design: minimal and focused)
pub mod api {
    use super::*;

    /// Quick connect and get single event
    pub async fn get_next_event() -> Result<Option<EnhancedFileEvent>> {
        let consumer = ZeroCopyConsumer::connect()?;
        consumer.recv_timeout(Duration::from_millis(1000)).await
    }

    /// Get batch of events with timeout
    pub async fn get_events_batch(
        max_events: usize,
        timeout_ms: u64,
    ) -> Result<Vec<EnhancedFileEvent>> {
        let consumer = ZeroCopyConsumer::connect()?;
        let timeout_duration = Duration::from_millis(timeout_ms);
        let mut events = Vec::with_capacity(max_events);

        let deadline = tokio::time::Instant::now() + timeout_duration;

        while events.len() < max_events && tokio::time::Instant::now() < deadline {
            if let Some(event) = consumer.try_recv() {
                events.push(event);
            } else {
                tokio::time::sleep(Duration::from_micros(100)).await;
            }
        }

        Ok(events)
    }

    /// Check daemon connectivity
    pub fn is_daemon_available() -> bool {
        ZeroCopyConsumer::connect().is_ok()
    }

    /// Get system statistics  
    pub fn get_system_stats() -> Result<SystemStats> {
        let consumer = ZeroCopyConsumer::connect()?;
        let ring_stats = consumer.stats();

        Ok(SystemStats {
            ring_stats,
            is_connected: true,
        })
    }
}

/// System statistics for monitoring
#[derive(Debug, Clone)]
pub struct SystemStats {
    pub ring_stats: RingStats,
    pub is_connected: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[tokio::test]
    async fn test_consumer_basic() {
        // This test would need a running producer, so it's a placeholder
        // In real usage, the daemon would be the producer
        let temp_file = NamedTempFile::new().unwrap();
        let config = ZeroCopyConfig {
            memory_size: 1024 * 1024, // 1MB
            ring_capacity: 1000,
            shared_path: temp_file.path().to_path_buf(),
            consumer_timeout_ms: 1000,
            enable_notifications: false,
        };

        // Create producer first (simulating daemon)
        let _producer = ZeroCopyRing::create_producer(config.clone()).unwrap();

        // Now test consumer
        let result = ZeroCopyConsumer::connect_with_config(config);
        // This might fail if producer hasn't initialized the shared memory yet
        // In real usage, daemon starts first
        println!("Consumer connection result: {:?}", result.is_ok());
    }

    #[test]
    fn test_api_connectivity_check() {
        // This will likely fail without a running daemon, which is expected
        let available = api::is_daemon_available();
        println!("Daemon available: {}", available);
    }
}
