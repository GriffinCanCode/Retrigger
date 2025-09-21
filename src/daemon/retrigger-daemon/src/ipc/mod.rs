//! Zero-Copy IPC Module
//! 
//! Complete shared memory IPC system for ultra-fast communication between 
//! Rust daemon and Node.js processes. Uses memory-mapped files for cross-process
//! zero-copy communication with sub-millisecond latency.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use anyhow::{Context, Result};
use memmap2::{MmapMut, MmapOptions};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use retrigger_system::EnhancedFileEvent;

/// Zero-copy IPC configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZeroCopyConfig {
    pub memory_size: usize,        // Total shared memory size
    pub ring_capacity: usize,      // Number of events in ring
    pub shared_path: PathBuf,      // Memory-mapped file path
    pub enable_notifications: bool, // Enable eventfd notifications
    pub consumer_timeout_ms: u64,  // Consumer read timeout
}

impl Default for ZeroCopyConfig {
    fn default() -> Self {
        Self {
            memory_size: 64 * 1024 * 1024,              // 64MB
            ring_capacity: 100_000,                     // 100K events
            shared_path: PathBuf::from("/tmp/retrigger-ipc.mmap"),
            enable_notifications: true,
            consumer_timeout_ms: 1000,                  // 1s timeout
        }
    }
}

/// Magic number for validation (RTRG in ASCII)
const MAGIC_NUMBER: u32 = 0x52545247;
const VERSION: u32 = 1;

/// Lock-free ring buffer header in shared memory
#[repr(C)]
pub struct RingHeader {
    // Validation and versioning
    magic: u32,
    version: u32,
    
    // Ring buffer control
    write_pos: AtomicU32,
    read_pos: AtomicU32,
    capacity: u32,
    event_size: u32,
    
    // Statistics and monitoring
    total_events: AtomicU64,
    dropped_events: AtomicU64,
    last_write_timestamp: AtomicU64,
    last_read_timestamp: AtomicU64,
    
    // State flags
    producer_pid: AtomicU32,
    consumer_pid: AtomicU32,
    shutdown_flag: AtomicU32,
    
    // Performance monitoring
    max_utilization: AtomicU32,
    avg_latency_ns: AtomicU64,
}

impl RingHeader {
    pub fn new(capacity: u32, event_size: u32) -> Self {
        Self {
            magic: MAGIC_NUMBER,
            version: VERSION,
            write_pos: AtomicU32::new(0),
            read_pos: AtomicU32::new(0),
            capacity,
            event_size,
            total_events: AtomicU64::new(0),
            dropped_events: AtomicU64::new(0),
            last_write_timestamp: AtomicU64::new(0),
            last_read_timestamp: AtomicU64::new(0),
            producer_pid: AtomicU32::new(0),
            consumer_pid: AtomicU32::new(0),
            shutdown_flag: AtomicU32::new(0),
            max_utilization: AtomicU32::new(0),
            avg_latency_ns: AtomicU64::new(0),
        }
    }
    
    pub fn is_valid(&self) -> bool {
        self.magic == MAGIC_NUMBER && self.version == VERSION
    }
}

/// Serialized file event for cross-process communication
#[repr(C)]
#[derive(Debug, Clone)]
pub struct SerializedFileEvent {
    timestamp: u64,
    event_type: u32,  // 0=created, 1=modified, 2=deleted, 3=moved, 4=metadata_changed
    path_len: u32,
    size: u64,
    is_directory: u32,
    hash_present: u32,
    hash_value: u64,
    path_data: [u8; 512], // Fixed-size path buffer
}

impl From<&EnhancedFileEvent> for SerializedFileEvent {
    fn from(event: &EnhancedFileEvent) -> Self {
        let path_string = event.system_event.path.to_string_lossy();
        let path_bytes = path_string.as_bytes();
        let path_len = std::cmp::min(path_bytes.len(), 511); // Leave room for null terminator
        
        let mut path_data = [0u8; 512];
        path_data[..path_len].copy_from_slice(&path_bytes[..path_len]);
        
        let event_type = match event.system_event.event_type {
            retrigger_system::SystemEventType::Created => 0,
            retrigger_system::SystemEventType::Modified => 1,
            retrigger_system::SystemEventType::Deleted => 2,
            retrigger_system::SystemEventType::Moved => 3,
            retrigger_system::SystemEventType::MetadataChanged => 4,
        };
        
        Self {
            timestamp: event.system_event.timestamp,
            event_type,
            path_len: path_len as u32,
            size: event.system_event.size,
            is_directory: if event.system_event.is_directory { 1 } else { 0 },
            hash_present: if event.hash.is_some() { 1 } else { 0 },
            hash_value: event.hash.as_ref().map(|h| h.hash).unwrap_or(0),
            path_data,
        }
    }
}

impl From<&SerializedFileEvent> for EnhancedFileEvent {
    fn from(ser: &SerializedFileEvent) -> Self {
        let path_str = std::str::from_utf8(&ser.path_data[..ser.path_len as usize])
            .unwrap_or("invalid_path");
        
        let event_type = match ser.event_type {
            0 => retrigger_system::SystemEventType::Created,
            1 => retrigger_system::SystemEventType::Modified, 
            2 => retrigger_system::SystemEventType::Deleted,
            3 => retrigger_system::SystemEventType::Moved,
            4 => retrigger_system::SystemEventType::MetadataChanged,
            _ => retrigger_system::SystemEventType::Modified,
        };
        
        use retrigger_system::{SystemEvent, EnhancedFileEvent};
        use retrigger_core::HashResult;
        
        let system_event = SystemEvent {
            path: PathBuf::from(path_str),
            event_type,
            timestamp: ser.timestamp,
            size: ser.size,
            is_directory: ser.is_directory == 1,
        };
        
        let hash = if ser.hash_present == 1 {
            Some(HashResult {
                hash: ser.hash_value,
                size: ser.size as u32,
                is_incremental: false,
            })
        } else {
            None
        };
        
        EnhancedFileEvent {
            system_event,
            hash,
            processing_time_ns: 0, // Will be set by consumer if needed
        }
    }
}

/// Zero-Copy Ring Buffer implementation
pub struct ZeroCopyRing {
    mmap: MmapMut,
    header: *const RingHeader,
    data_start: *mut u8,
    config: ZeroCopyConfig,
    is_producer: bool,
    notifications_fd: Option<i32>,
}

unsafe impl Send for ZeroCopyRing {}
unsafe impl Sync for ZeroCopyRing {}

impl ZeroCopyRing {
    /// Create producer (writer) instance
    pub fn create_producer(config: ZeroCopyConfig) -> Result<Self> {
        info!("Creating IPC producer: {}", config.shared_path.display());
        
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&config.shared_path)
            .context("Failed to create IPC file")?;

        file.set_len(config.memory_size as u64)
            .context("Failed to set file size")?;

        let mmap = unsafe {
            MmapOptions::new()
                .map_mut(&file)
                .context("Failed to map memory")?
        };

        let header_ptr = mmap.as_ptr() as *mut RingHeader;
        
        // Initialize header (only producer does this)
        let event_size = std::mem::size_of::<SerializedFileEvent>() as u32;
        let header = RingHeader::new(config.ring_capacity as u32, event_size);
        
        unsafe {
            std::ptr::write(header_ptr, header);
            let header_ref = &*header_ptr;
            header_ref.producer_pid.store(std::process::id(), Ordering::Release);
        }

        let data_start = unsafe {
            mmap.as_ptr()
                .add(std::mem::size_of::<RingHeader>()) as *mut u8
        };

        // Setup eventfd for notifications if enabled
        let notifications_fd = if config.enable_notifications {
            Self::create_eventfd().ok()
        } else {
            None
        };

        info!("Created zero-copy ring buffer: {} events, {} bytes", 
              config.ring_capacity, config.memory_size);
        
        Ok(Self {
            mmap,
            header: header_ptr,
            data_start,
            config,
            is_producer: true,
            notifications_fd,
        })
    }

    /// Create consumer (reader) instance  
    pub fn create_consumer(config: ZeroCopyConfig) -> Result<Self> {
        info!("Creating IPC consumer: {}", config.shared_path.display());
        
        // Wait for producer to create the file
        let mut attempts = 0;
        let file = loop {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&config.shared_path) {
                Ok(file) => break file,
                Err(_) if attempts < 100 => {
                    attempts += 1;
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(e) => return Err(e).context("Failed to open IPC file after waiting"),
            }
        };

        let mmap = unsafe {
            MmapOptions::new()
                .map_mut(&file)
                .context("Failed to map memory")?
        };

        let header_ptr = mmap.as_ptr() as *const RingHeader;
        let header = unsafe { &*header_ptr };
        
        // Validate the shared memory
        if !header.is_valid() {
            return Err(anyhow::anyhow!("Invalid shared memory header"));
        }

        // Register as consumer
        header.consumer_pid.store(std::process::id(), Ordering::Release);

        let data_start = unsafe {
            mmap.as_ptr()
                .add(std::mem::size_of::<RingHeader>()) as *mut u8
        };

        // Setup eventfd for notifications
        let notifications_fd = if config.enable_notifications {
            Self::create_eventfd().ok()
        } else {
            None
        };

        info!("Connected to zero-copy ring buffer");
        
        Ok(Self {
            mmap,
            header: header_ptr,
            data_start,
            config,
            is_producer: false,
            notifications_fd,
        })
    }

    /// Create eventfd for notifications (Linux only)
    #[cfg(target_os = "linux")]
    fn create_eventfd() -> Result<i32> {
        let fd = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK) };
        if fd < 0 {
            Err(anyhow::anyhow!("Failed to create eventfd"))
        } else {
            Ok(fd)
        }
    }
    
    #[cfg(not(target_os = "linux"))]
    fn create_eventfd() -> Result<i32> {
        Err(anyhow::anyhow!("eventfd not supported on this platform"))
    }

    /// Zero-copy push (producer only)
    pub fn push(&self, event: &EnhancedFileEvent) -> bool {
        if !self.is_producer {
            warn!("Attempted to push from consumer");
            return false;
        }

        let header = unsafe { &*self.header };
        let write_pos = header.write_pos.load(Ordering::Acquire);
        let read_pos = header.read_pos.load(Ordering::Acquire);
        
        let next_write = (write_pos + 1) % header.capacity;
        if next_write == read_pos {
            header.dropped_events.fetch_add(1, Ordering::Relaxed);
            return false; // Ring buffer full
        }

        // Serialize event for cross-process communication
        let serialized = SerializedFileEvent::from(event);

        // Zero-copy write directly to shared memory
        let event_ptr = unsafe {
            self.data_start.add((write_pos as usize) * header.event_size as usize)
        } as *mut SerializedFileEvent;
        
        unsafe {
            std::ptr::write(event_ptr, serialized);
        }
        
        // Update statistics
        let now = SystemTime::now().duration_since(UNIX_EPOCH)
            .unwrap_or_default().as_nanos() as u64;
        header.last_write_timestamp.store(now, Ordering::Relaxed);
        header.total_events.fetch_add(1, Ordering::Relaxed);
        
        // Update utilization tracking
        let utilization = ((next_write.wrapping_sub(read_pos)) * 100) / header.capacity;
        let current_max = header.max_utilization.load(Ordering::Relaxed);
        if utilization > current_max {
            header.max_utilization.store(utilization, Ordering::Relaxed);
        }
        
        // Commit write
        header.write_pos.store(next_write, Ordering::Release);
        
        // Notify consumer if enabled
        if let Some(fd) = self.notifications_fd {
            self.notify_consumer(fd);
        }
        
        true
    }

    /// Zero-copy pop (consumer only)
    pub fn pop(&self) -> Option<EnhancedFileEvent> {
        if self.is_producer {
            warn!("Attempted to pop from producer");
            return None;
        }

        let header = unsafe { &*self.header };
        let read_pos = header.read_pos.load(Ordering::Acquire);
        let write_pos = header.write_pos.load(Ordering::Acquire);
        
        if read_pos == write_pos {
            return None; // Ring buffer empty
        }

        // Zero-copy read directly from shared memory
        let event_ptr = unsafe {
            self.data_start.add((read_pos as usize) * header.event_size as usize)
        } as *const SerializedFileEvent;
        
        let serialized = unsafe { std::ptr::read(event_ptr) };
        let event = EnhancedFileEvent::from(&serialized);
        
        // Update statistics
        let now = SystemTime::now().duration_since(UNIX_EPOCH)
            .unwrap_or_default().as_nanos() as u64;
        header.last_read_timestamp.store(now, Ordering::Relaxed);
        
        // Calculate and update latency
        let latency = now.saturating_sub(serialized.timestamp);
        let current_avg = header.avg_latency_ns.load(Ordering::Relaxed);
        let new_avg = if current_avg == 0 { latency } else { (current_avg + latency) / 2 };
        header.avg_latency_ns.store(new_avg, Ordering::Relaxed);
        
        // Commit read
        let next_read = (read_pos + 1) % header.capacity;
        header.read_pos.store(next_read, Ordering::Release);
        
        Some(event)
    }

    /// Notify consumer via eventfd
    fn notify_consumer(&self, fd: i32) {
        #[cfg(target_os = "linux")]
        unsafe {
            let value: u64 = 1;
            libc::write(fd, &value as *const u64 as *const libc::c_void, 8);
        }
        
        #[cfg(not(target_os = "linux"))]
        let _ = fd; // Unused on non-Linux platforms
    }

    /// Wait for events with timeout (consumer only)
    pub fn wait_for_events(&self, timeout_ms: u64) -> bool {
        if self.is_producer {
            return false;
        }

        let header = unsafe { &*self.header };
        let read_pos = header.read_pos.load(Ordering::Acquire);
        let write_pos = header.write_pos.load(Ordering::Acquire);
        
        if read_pos != write_pos {
            return true; // Events already available
        }

        // Use eventfd if available, otherwise poll
        if let Some(fd) = self.notifications_fd {
            self.wait_on_eventfd(fd, timeout_ms)
        } else {
            // Fallback polling
            let start = std::time::Instant::now();
            while start.elapsed().as_millis() < timeout_ms as u128 {
                let read_pos = header.read_pos.load(Ordering::Acquire);
                let write_pos = header.write_pos.load(Ordering::Acquire);
                if read_pos != write_pos {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            false
        }
    }

    /// Wait on eventfd with timeout
    #[cfg(target_os = "linux")]
    fn wait_on_eventfd(&self, fd: i32, timeout_ms: u64) -> bool {
        use std::os::unix::io::RawFd;
        
        let mut poll_fd = libc::pollfd {
            fd: fd as RawFd,
            events: libc::POLLIN,
            revents: 0,
        };
        
        let result = unsafe { libc::poll(&mut poll_fd, 1, timeout_ms as i32) };
        
        if result > 0 && (poll_fd.revents & libc::POLLIN) != 0 {
            // Read the eventfd value to reset it
            let mut value: u64 = 0;
            unsafe {
                libc::read(fd, &mut value as *mut u64 as *mut libc::c_void, 8);
            }
            true
        } else {
            false
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn wait_on_eventfd(&self, _fd: i32, timeout_ms: u64) -> bool {
        // Fallback polling on non-Linux systems
        let start = std::time::Instant::now();
        let header = unsafe { &*self.header };
        
        while start.elapsed().as_millis() < timeout_ms as u128 {
            let read_pos = header.read_pos.load(Ordering::Acquire);
            let write_pos = header.write_pos.load(Ordering::Acquire);
            if read_pos != write_pos {
                return true;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        false
    }

    /// Get comprehensive buffer statistics
    pub fn stats(&self) -> RingStats {
        let header = unsafe { &*self.header };
        let write_pos = header.write_pos.load(Ordering::Acquire);
        let read_pos = header.read_pos.load(Ordering::Acquire);
        
        let used = if write_pos >= read_pos {
            write_pos - read_pos
        } else {
            header.capacity - read_pos + write_pos
        };
        
        RingStats {
            capacity: header.capacity as usize,
            used: used as usize,
            utilization: (used as f64 / header.capacity as f64) * 100.0,
            total_events: header.total_events.load(Ordering::Relaxed),
            dropped_events: header.dropped_events.load(Ordering::Relaxed),
            avg_latency_us: header.avg_latency_ns.load(Ordering::Relaxed) / 1000,
            max_utilization: header.max_utilization.load(Ordering::Relaxed) as f64,
            producer_pid: header.producer_pid.load(Ordering::Relaxed),
            consumer_pid: header.consumer_pid.load(Ordering::Relaxed),
        }
    }

    /// Signal shutdown to all consumers
    pub fn shutdown(&self) {
        let header = unsafe { &*self.header };
        header.shutdown_flag.store(1, Ordering::Release);
        
        // Notify all consumers
        if let Some(fd) = self.notifications_fd {
            self.notify_consumer(fd);
        }
    }

    /// Check if shutdown has been signaled
    pub fn is_shutdown(&self) -> bool {
        let header = unsafe { &*self.header };
        header.shutdown_flag.load(Ordering::Acquire) != 0
    }

    /// Get the file descriptor for external polling (Linux only)
    pub fn get_event_fd(&self) -> Option<i32> {
        self.notifications_fd
    }

    /// Get the memory mapped file path for Node.js integration
    pub fn get_mmap_path(&self) -> &PathBuf {
        &self.config.shared_path
    }
}

impl Drop for ZeroCopyRing {
    fn drop(&mut self) {
        // Signal shutdown
        self.shutdown();
        
        // Close eventfd if open
        if let Some(fd) = self.notifications_fd {
            #[cfg(target_os = "linux")]
            unsafe {
                if libc::close(fd) != 0 {
                    warn!("Failed to close eventfd {}: {}", fd, std::io::Error::last_os_error());
                }
            }
        }
        
        // If we're the producer, cleanup the shared file
        if self.is_producer {
            let _ = std::fs::remove_file(&self.config.shared_path);
        }
    }
}

/// Comprehensive ring buffer statistics
#[derive(Debug, Clone)]
pub struct RingStats {
    pub capacity: usize,
    pub used: usize,
    pub utilization: f64,
    pub total_events: u64,
    pub dropped_events: u64,
    pub avg_latency_us: u64,
    pub max_utilization: f64,
    pub producer_pid: u32,
    pub consumer_pid: u32,
}

/// IPC Manager for handling multiple consumers
pub struct IPCManager {
    producer_ring: Option<Arc<ZeroCopyRing>>,
    consumers: Vec<Arc<ZeroCopyRing>>,
    config: ZeroCopyConfig,
}

impl IPCManager {
    pub fn new(config: ZeroCopyConfig) -> Self {
        Self {
            producer_ring: None,
            consumers: Vec::new(),
            config,
        }
    }

    /// Start as producer
    pub async fn start_producer(&mut self) -> Result<Arc<ZeroCopyRing>> {
        let ring = Arc::new(ZeroCopyRing::create_producer(self.config.clone())?);
        self.producer_ring = Some(Arc::clone(&ring));
        info!("IPC Manager started as producer");
        Ok(ring)
    }

    /// Connect as consumer
    pub async fn connect_consumer(&mut self) -> Result<Arc<ZeroCopyRing>> {
        let ring = Arc::new(ZeroCopyRing::create_consumer(self.config.clone())?);
        self.consumers.push(Arc::clone(&ring));
        info!("IPC Manager connected consumer #{}", self.consumers.len());
        Ok(ring)
    }

    /// Get aggregated statistics from all connections
    pub fn get_stats(&self) -> IPCStats {
        let producer_stats = self.producer_ring.as_ref().map(|r| r.stats());
        let consumer_stats: Vec<RingStats> = self.consumers.iter().map(|r| r.stats()).collect();

        IPCStats {
            producer_stats,
            consumer_stats,
            total_consumers: self.consumers.len(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct IPCStats {
    pub producer_stats: Option<RingStats>,
    pub consumer_stats: Vec<RingStats>,
    pub total_consumers: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;
    use retrigger_system::{FileInfo, HashInfo};

    #[test]
    fn test_zero_copy_ring_basic() {
        let temp_file = NamedTempFile::new().unwrap();
        let config = ZeroCopyConfig {
            memory_size: 1024 * 1024, // 1MB
            ring_capacity: 1000,
            shared_path: temp_file.path().to_path_buf(),
            enable_notifications: false,
            consumer_timeout_ms: 100,
        };

        let producer = ZeroCopyRing::create_producer(config.clone()).unwrap();
        let consumer = ZeroCopyRing::create_consumer(config).unwrap();

        // Test stats
        let stats = producer.stats();
        assert_eq!(stats.capacity, 1000);
        assert_eq!(stats.used, 0);
        assert_eq!(stats.utilization, 0.0);

        // Test event push/pop
        let test_event = EnhancedFileEvent {
            path: PathBuf::from("/test/file.txt"),
            event_type: "modified".to_string(),
            timestamp: 123456789,
            file_info: Some(FileInfo {
                size: 1024,
                is_directory: false,
                permissions: 0o644,
                modified_time: 123456789,
            }),
            hash_info: Some(HashInfo {
                hash: 0xDEADBEEF,
                algorithm: "XXH3".to_string(),
                is_incremental: false,
            }),
            metadata: std::collections::HashMap::new(),
        };

        // Push event
        assert!(producer.push(&test_event));
        
        // Check stats after push
        let stats = producer.stats();
        assert_eq!(stats.used, 1);
        assert!(stats.utilization > 0.0);

        // Pop event
        let received = consumer.pop().unwrap();
        assert_eq!(received.path, test_event.path);
        assert_eq!(received.event_type, test_event.event_type);
        
        // Check stats after pop
        let stats = consumer.stats();
        assert_eq!(stats.used, 0);
    }

    #[tokio::test]
    async fn test_ipc_manager() {
        let temp_file = NamedTempFile::new().unwrap();
        let config = ZeroCopyConfig {
            memory_size: 1024 * 1024,
            ring_capacity: 1000,
            shared_path: temp_file.path().to_path_buf(),
            enable_notifications: false,
            consumer_timeout_ms: 100,
        };

        let mut manager = IPCManager::new(config);
        
        // Start producer
        let producer = manager.start_producer().await.unwrap();
        
        // Connect consumer
        let consumer = manager.connect_consumer().await.unwrap();
        
        // Test communication
        let test_event = EnhancedFileEvent {
            path: PathBuf::from("/test/manager.txt"),
            event_type: "created".to_string(),
            timestamp: 987654321,
            file_info: None,
            hash_info: None,
            metadata: std::collections::HashMap::new(),
        };

        assert!(producer.push(&test_event));
        
        let received = consumer.pop().unwrap();
        assert_eq!(received.path, test_event.path);
        assert_eq!(received.event_type, test_event.event_type);
        
        // Check manager stats
        let stats = manager.get_stats();
        assert!(stats.producer_stats.is_some());
        assert_eq!(stats.consumer_stats.len(), 1);
        assert_eq!(stats.total_consumers, 1);
    }
}