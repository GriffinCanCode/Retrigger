/**
 * IPC Bridge - Direct connection to Rust daemon's memory-mapped file
 *
 * This module provides zero-copy communication with the Rust daemon
 * by reading directly from the shared memory-mapped file.
 */

const fs = require('fs');
const { EventEmitter } = require('events');

/**
 * Memory layout constants matching Rust implementation
 */
const MEMORY_LAYOUT = {
  // Header structure (must match RingHeader in Rust)
  MAGIC_OFFSET: 0, // u32: Magic number (0x52545247)
  VERSION_OFFSET: 4, // u32: Version
  WRITE_POS_OFFSET: 8, // u32: Write position (atomic)
  READ_POS_OFFSET: 12, // u32: Read position (atomic)
  CAPACITY_OFFSET: 16, // u32: Ring capacity
  EVENT_SIZE_OFFSET: 20, // u32: Event size in bytes
  TOTAL_EVENTS_OFFSET: 24, // u64: Total events processed
  DROPPED_EVENTS_OFFSET: 32, // u64: Dropped events
  LAST_WRITE_TS_OFFSET: 40, // u64: Last write timestamp
  LAST_READ_TS_OFFSET: 48, // u64: Last read timestamp
  PRODUCER_PID_OFFSET: 56, // u32: Producer PID
  CONSUMER_PID_OFFSET: 60, // u32: Consumer PID
  SHUTDOWN_FLAG_OFFSET: 64, // u32: Shutdown flag
  MAX_UTILIZATION_OFFSET: 68, // u32: Max utilization
  AVG_LATENCY_OFFSET: 72, // u64: Average latency

  HEADER_SIZE: 128, // Total header size (aligned)

  // Event structure constants
  EVENT_TIMESTAMP_OFFSET: 0, // u64: Event timestamp
  EVENT_TYPE_OFFSET: 8, // u32: Event type (0-4)
  EVENT_PATH_LEN_OFFSET: 12, // u32: Path length
  EVENT_SIZE_OFFSET: 16, // u64: File size
  EVENT_IS_DIR_OFFSET: 24, // u32: Is directory
  EVENT_HASH_PRESENT_OFFSET: 28, // u32: Hash present flag
  EVENT_HASH_VALUE_OFFSET: 32, // u64: Hash value
  EVENT_PATH_DATA_OFFSET: 40, // [u8; 512]: Path data

  SERIALIZED_EVENT_SIZE: 552, // Total serialized event size
};

const MAGIC_NUMBER = 0x52545247; // 'RTRG' in little endian
const VERSION = 1;

/**
 * Event type mapping (must match Rust enum)
 */
const EVENT_TYPES = {
  0: 'created',
  1: 'modified',
  2: 'deleted',
  3: 'moved',
  4: 'metadata_changed',
};

/**
 * Direct memory-mapped file reader for the Rust daemon IPC
 */
class RustIPCBridge extends EventEmitter {
  constructor(mmapPath = '/tmp/retrigger-ipc.mmap') {
    super();
    this.mmapPath = mmapPath;
    this.buffer = null;
    this.fd = null;
    this.isConnected = false;
    this.polling = false;
    this.pollInterval = null;
    this.consumerPid = process.pid;

    // Statistics
    this.stats = {
      eventsRead: 0,
      lastReadTime: 0,
      connectionTime: 0,
      averageLatency: 0,
    };
  }

  /**
   * Connect to the Rust daemon's shared memory
   * @returns {Promise<void>}
   */
  async connect() {
    try {
      // Wait for the memory-mapped file to be created by Rust daemon
      await this.waitForFile();

      // Open the memory-mapped file
      this.fd = fs.openSync(this.mmapPath, 'r+');

      // Get file size and map it
      const stats = fs.fstatSync(this.fd);
      this.buffer = Buffer.alloc(stats.size);

      // Read the entire file into buffer (this acts as our memory map)
      const bytesRead = fs.readSync(this.fd, this.buffer, 0, stats.size, 0);
      if (bytesRead !== stats.size) {
        throw new Error(
          `Failed to read complete memory map: ${bytesRead}/${stats.size}`
        );
      }

      // Validate the header
      this.validateHeader();

      // Register as consumer
      this.registerConsumer();

      this.isConnected = true;
      this.stats.connectionTime = Date.now();

      console.log('Connected to Rust daemon IPC bridge');
      this.emit('connected');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Wait for the memory-mapped file to be created
   * @private
   */
  async waitForFile(timeoutMs = 5000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        if (fs.existsSync(this.mmapPath)) {
          // Wait a bit more for the file to be fully initialized
          await new Promise((resolve) => setTimeout(resolve, 100));
          return;
        }
      } catch (error) {
        // File might be in process of being created
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(
      `Rust daemon IPC file not found after ${timeoutMs}ms: ${this.mmapPath}`
    );
  }

  /**
   * Validate the shared memory header
   * @private
   */
  validateHeader() {
    const magic = this.buffer.readUInt32LE(MEMORY_LAYOUT.MAGIC_OFFSET);
    const version = this.buffer.readUInt32LE(MEMORY_LAYOUT.VERSION_OFFSET);

    if (magic !== MAGIC_NUMBER) {
      throw new Error(
        `Invalid magic number: 0x${magic.toString(16)} (expected 0x${MAGIC_NUMBER.toString(16)})`
      );
    }

    if (version !== VERSION) {
      throw new Error(`Unsupported version: ${version} (expected ${VERSION})`);
    }

    console.log('Shared memory header validated');
  }

  /**
   * Register this process as a consumer
   * @private
   */
  registerConsumer() {
    // Atomic write to register our PID
    this.buffer.writeUInt32LE(
      this.consumerPid,
      MEMORY_LAYOUT.CONSUMER_PID_OFFSET
    );
  }

  /**
   * Start polling for events
   */
  startPolling(intervalMs = 1) {
    if (this.polling) return;

    this.polling = true;
    this.pollInterval = setInterval(() => {
      this.processEvents();
    }, intervalMs);

    console.log(`Started event polling with ${intervalMs}ms interval`);
  }

  /**
   * Stop polling for events
   */
  stopPolling() {
    if (!this.polling) return;

    this.polling = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    console.log('Stopped event polling');
  }

  /**
   * Process available events from the ring buffer
   * @private
   */
  processEvents() {
    if (!this.isConnected) return;

    try {
      // Re-read the memory-mapped buffer to get latest data
      this.refreshBuffer();

      // Check for shutdown
      const shutdownFlag = this.buffer.readUInt32LE(
        MEMORY_LAYOUT.SHUTDOWN_FLAG_OFFSET
      );
      if (shutdownFlag !== 0) {
        this.emit('shutdown');
        return;
      }

      // Read events from ring buffer
      const events = this.readAvailableEvents();

      // Emit events
      events.forEach((event) => {
        this.emit('file-event', event);
      });

      if (events.length > 0) {
        this.emit('batch-processed', events.length);
        this.stats.eventsRead += events.length;
        this.stats.lastReadTime = Date.now();
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  /**
   * Refresh the buffer from the memory-mapped file
   * @private
   */
  refreshBuffer() {
    if (!this.fd) return;

    try {
      // Read the header to check for updates
      const headerBuffer = Buffer.alloc(MEMORY_LAYOUT.HEADER_SIZE);
      fs.readSync(this.fd, headerBuffer, 0, MEMORY_LAYOUT.HEADER_SIZE, 0);

      // Copy header to main buffer
      headerBuffer.copy(this.buffer, 0);
    } catch (error) {
      // Handle case where file might be temporarily locked
      console.warn('Failed to refresh buffer:', error.message);
    }
  }

  /**
   * Read all available events from the ring buffer
   * @private
   * @returns {Array} Array of file events
   */
  readAvailableEvents() {
    const events = [];
    const maxEvents = 1000; // Prevent infinite loops

    for (let i = 0; i < maxEvents; i++) {
      const event = this.readNextEvent();
      if (!event) break;
      events.push(event);
    }

    return events;
  }

  /**
   * Read the next available event from the ring buffer
   * @private
   * @returns {Object|null} File event or null if no events available
   */
  readNextEvent() {
    // Get ring buffer positions
    const writePos = this.buffer.readUInt32LE(MEMORY_LAYOUT.WRITE_POS_OFFSET);
    let readPos = this.buffer.readUInt32LE(MEMORY_LAYOUT.READ_POS_OFFSET);

    // Check if events are available
    if (readPos === writePos) {
      return null; // No events available
    }

    const capacity = this.buffer.readUInt32LE(MEMORY_LAYOUT.CAPACITY_OFFSET);
    const eventSize = this.buffer.readUInt32LE(MEMORY_LAYOUT.EVENT_SIZE_OFFSET);

    // Calculate event position
    const eventOffset = MEMORY_LAYOUT.HEADER_SIZE + readPos * eventSize;

    // Read and deserialize event
    const event = this.deserializeEvent(eventOffset);

    // Update read position
    const nextReadPos = (readPos + 1) % capacity;
    this.buffer.writeUInt32LE(nextReadPos, MEMORY_LAYOUT.READ_POS_OFFSET);

    // Update statistics
    if (event) {
      const now = Date.now();
      const latency = now - event.timestamp / 1000000; // Convert ns to ms
      this.stats.averageLatency = (this.stats.averageLatency + latency) / 2;
    }

    return event;
  }

  /**
   * Deserialize a file event from the buffer
   * @private
   * @param {number} offset - Offset in buffer
   * @returns {Object|null} Deserialized event
   */
  deserializeEvent(offset) {
    try {
      // Read event fields
      const timestamp = this.buffer.readBigUInt64LE(
        offset + MEMORY_LAYOUT.EVENT_TIMESTAMP_OFFSET
      );
      const eventType = this.buffer.readUInt32LE(
        offset + MEMORY_LAYOUT.EVENT_TYPE_OFFSET
      );
      const pathLen = this.buffer.readUInt32LE(
        offset + MEMORY_LAYOUT.EVENT_PATH_LEN_OFFSET
      );
      const size = this.buffer.readBigUInt64LE(
        offset + MEMORY_LAYOUT.EVENT_SIZE_OFFSET
      );
      const isDirectory =
        this.buffer.readUInt32LE(offset + MEMORY_LAYOUT.EVENT_IS_DIR_OFFSET) !==
        0;
      const hashPresent =
        this.buffer.readUInt32LE(
          offset + MEMORY_LAYOUT.EVENT_HASH_PRESENT_OFFSET
        ) !== 0;
      const hashValue = this.buffer.readBigUInt64LE(
        offset + MEMORY_LAYOUT.EVENT_HASH_VALUE_OFFSET
      );

      // Read path data
      if (pathLen === 0 || pathLen > 511) {
        console.warn(`Invalid path length: ${pathLen}`);
        return null;
      }

      const pathBuffer = this.buffer.subarray(
        offset + MEMORY_LAYOUT.EVENT_PATH_DATA_OFFSET,
        offset + MEMORY_LAYOUT.EVENT_PATH_DATA_OFFSET + pathLen
      );
      const path = pathBuffer.toString('utf8');

      // Create event object
      return {
        path,
        event_type: EVENT_TYPES[eventType] || 'modified',
        timestamp: timestamp.toString(),
        size: size.toString(),
        is_directory: isDirectory,
        hash: hashPresent
          ? {
              hash: hashValue.toString(),
              algorithm: 'XXH3',
              is_incremental: false,
            }
          : null,
      };
    } catch (error) {
      console.error('Failed to deserialize event:', error);
      return null;
    }
  }

  /**
   * Get comprehensive statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    if (!this.isConnected) {
      return { connected: false };
    }

    try {
      const writePos = this.buffer.readUInt32LE(MEMORY_LAYOUT.WRITE_POS_OFFSET);
      const readPos = this.buffer.readUInt32LE(MEMORY_LAYOUT.READ_POS_OFFSET);
      const capacity = this.buffer.readUInt32LE(MEMORY_LAYOUT.CAPACITY_OFFSET);
      const totalEvents = this.buffer.readBigUInt64LE(
        MEMORY_LAYOUT.TOTAL_EVENTS_OFFSET
      );
      const droppedEvents = this.buffer.readBigUInt64LE(
        MEMORY_LAYOUT.DROPPED_EVENTS_OFFSET
      );
      const producerPid = this.buffer.readUInt32LE(
        MEMORY_LAYOUT.PRODUCER_PID_OFFSET
      );
      const maxUtilization = this.buffer.readUInt32LE(
        MEMORY_LAYOUT.MAX_UTILIZATION_OFFSET
      );
      const avgLatency = this.buffer.readBigUInt64LE(
        MEMORY_LAYOUT.AVG_LATENCY_OFFSET
      );

      const pending =
        writePos >= readPos
          ? writePos - readPos
          : capacity - readPos + writePos;

      return {
        connected: true,
        mmapPath: this.mmapPath,
        consumerPid: this.consumerPid,
        producerPid,

        // Ring buffer stats
        capacity,
        pending,
        utilization: (pending / capacity) * 100,

        // Event statistics
        totalEvents: totalEvents.toString(),
        droppedEvents: droppedEvents.toString(),
        eventsRead: this.stats.eventsRead,

        // Performance metrics
        maxUtilization,
        avgLatencyUs: Number(avgLatency) / 1000,
        clientAvgLatencyMs: this.stats.averageLatency,

        // Connection info
        connectionTime: this.stats.connectionTime,
        lastReadTime: this.stats.lastReadTime,
        uptime: Date.now() - this.stats.connectionTime,
      };
    } catch (error) {
      return {
        connected: true,
        error: error.message,
      };
    }
  }

  /**
   * Disconnect from the shared memory
   */
  disconnect() {
    this.stopPolling();

    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch (error) {
        console.warn('Error closing file descriptor:', error);
      }
      this.fd = null;
    }

    this.buffer = null;
    this.isConnected = false;

    console.log('Disconnected from Rust daemon IPC bridge');
    this.emit('disconnected');
  }

  /**
   * Check if the daemon is still running
   * @returns {boolean} True if daemon is responsive
   */
  isDaemonAlive() {
    if (!this.isConnected) return false;

    try {
      const producerPid = this.buffer.readUInt32LE(
        MEMORY_LAYOUT.PRODUCER_PID_OFFSET
      );
      if (producerPid === 0) return false;

      // Check if process exists (Unix-specific)
      try {
        process.kill(producerPid, 0); // Signal 0 checks existence without killing
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') {
          return false; // Process doesn't exist
        }
        throw error;
      }
    } catch (error) {
      return false;
    }
  }
}

module.exports = {
  RustIPCBridge,
  MEMORY_LAYOUT,
  EVENT_TYPES,
  MAGIC_NUMBER,
  VERSION,
};
