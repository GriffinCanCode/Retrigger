//! Zero-Copy IPC Example
//! 
//! Demonstrates how to use the enhanced Retrigger system with zero-copy IPC
//! and hierarchical hash caching following 2025 best practices.

use std::time::Duration;
use tokio::time::sleep;
use tracing::{info, warn};

use retrigger_daemon::api::ZeroCopyConsumer;
use retrigger_daemon::ipc::ZeroCopyConfig;
use retrigger_system::{FileEventProcessor, CacheConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    info!("Starting Retrigger Zero-Copy Example");

    // Example 1: Enhanced FileEventProcessor with hierarchical cache
    demonstrate_enhanced_processor().await?;

    // Example 2: Zero-Copy IPC Consumer  
    demonstrate_zero_copy_consumer().await?;

    Ok(())
}

/// Demonstrate the enhanced FileEventProcessor with built-in hierarchical cache
async fn demonstrate_enhanced_processor() -> Result<(), Box<dyn std::error::Error>> {
    info!("=== Enhanced FileEventProcessor Demo ===");

    // Create enhanced processor with custom cache config
    let cache_config = CacheConfig {
        max_entries: 10_000,
        ttl_seconds: 1800, // 30 minutes
        enable_hierarchy: true,
    };
    
    let processor = FileEventProcessor::with_config(cache_config);

    // Get initial cache statistics
    let stats = processor.detailed_cache_stats();
    info!("Initial cache stats: {:?}", stats);

    info!("Enhanced processor created with hierarchical caching");
    
    // Demonstrate cache cleanup
    processor.cleanup_cache(Duration::from_secs(3600)).await;
    info!("Cache cleanup completed");

    Ok(())
}

/// Demonstrate zero-copy IPC consumer
async fn demonstrate_zero_copy_consumer() -> Result<(), Box<dyn std::error::Error>> {
    info!("=== Zero-Copy IPC Consumer Demo ===");

    // Try to connect to daemon's IPC ring buffer
    match ZeroCopyConsumer::connect() {
        Ok(consumer) => {
            info!("Connected to daemon's zero-copy IPC channel");

            // Get ring buffer statistics
            let stats = consumer.stats();
            info!("Ring buffer stats: capacity={}, used={}, utilization={:.1}%", 
                  stats.capacity, stats.used, stats.utilization);

            // Try to receive events with timeout
            info!("Listening for events...");
            
            for i in 0..5 {
                match consumer.recv_timeout(Duration::from_millis(500)).await? {
                    Some(event) => {
                        info!("Received event {}: path={}, hash={:?}", 
                              i + 1, event.system_event.path.display(), event.hash);
                    }
                    None => {
                        info!("No events received in timeout period");
                    }
                }
            }

            // Demonstrate batch processing
            info!("Demonstrating batch event processing...");
            let events = consumer.iter_batch(10).collect::<Vec<_>>();
            info!("Collected {} events in batch", events.len());

        }
        Err(e) => {
            warn!("Could not connect to daemon IPC: {}. Is the daemon running?", e);
            info!("To test IPC, start the daemon first: cargo run --bin retrigger start");
        }
    }

    Ok(())
}

/// Example usage patterns
#[allow(dead_code)]
mod usage_examples {
    use super::*;

    /// Simple event monitoring
    pub async fn monitor_events() -> Result<(), Box<dyn std::error::Error>> {
        let consumer = ZeroCopyConsumer::connect()?;
        
        loop {
            if let Some(event) = consumer.try_recv() {
                println!("File changed: {}", event.system_event.path.display());
                
                if let Some(hash) = event.hash {
                    println!("  Hash: {}", hash.hash);
                    println!("  Size: {} bytes", hash.size);
                }
            }
            
            sleep(Duration::from_millis(10)).await;
        }
    }

    /// Batch processing for high throughput
    pub async fn process_batch() -> Result<(), Box<dyn std::error::Error>> {
        let consumer = ZeroCopyConsumer::connect()?;
        
        // Process events in batches of 100
        for batch in consumer.iter_batch(100).collect::<Vec<_>>().chunks(100) {
            println!("Processing batch of {} events", batch.len());
            
            for event in batch {
                // Process event with zero copying
                handle_event(event);
            }
        }
        
        Ok(())
    }
    
    fn handle_event(event: &retrigger_system::EnhancedFileEvent) {
        // Your event processing logic here
        println!("Processed: {}", event.system_event.path.display());
    }
}
