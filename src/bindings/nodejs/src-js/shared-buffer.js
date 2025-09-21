/**
 * Zero-Copy IPC Communication System
 * Direct connection to Rust daemon using shared memory-mapped files
 * 
 * This replaces the previous SharedArrayBuffer + Worker approach with
 * direct memory-mapped file access to the Rust daemon for true zero-copy
 * inter-process communication with sub-millisecond latency.
 * 
 * Features:
 * - Direct memory access to Rust daemon's ring buffer
 * - Zero-copy event deserialization 
 * - Sub-millisecond latency
 * - Automatic reconnection and error recovery
 * - Comprehensive performance monitoring
 */

const { EventEmitter } = require('events');
const { RustIPCBridge } = require('./ipc-bridge');

/**
 * Memory layout constants for SharedArrayBuffer
 */
const MEMORY_LAYOUT = {
  HEADER_SIZE: 64,           // Header information (64 bytes)
  CONTROL_OFFSET: 0,         // Control flags (4 bytes)
  WRITE_POS_OFFSET: 4,       // Write position (4 bytes) 
  READ_POS_OFFSET: 8,        // Read position (4 bytes)
  EVENT_COUNT_OFFSET: 12,    // Total events processed (8 bytes)
  BUFFER_SIZE_OFFSET: 20,    // Buffer size (4 bytes)
  MAX_EVENT_SIZE: 512,       // Maximum size per event (bytes)
  MAGIC_NUMBER: 0x52545247,  // 'RTRG' magic number
};

/**
 * Control flags for buffer state management
 */
const CONTROL_FLAGS = {
  READY: 0x01,
  WRITING: 0x02,
  READING: 0x04,
  SHUTDOWN: 0x08,
  ERROR: 0x10,
};

/**
 * Abstract base class for SharedArrayBuffer communication
 * Implements Interface Segregation Principle
 */
class SharedBufferInterface {
  constructor(buffer, isProducer = false) {
    if (new.target === SharedBufferInterface) {
      throw new Error('Cannot instantiate abstract class');
    }
    
    this.buffer = buffer;
    this.view = new Int32Array(buffer);
    this.byteView = new Uint8Array(buffer);
    this.isProducer = isProducer;
    this.isReady = false;
  }

  /**
   * Initialize the buffer structure
   * @protected
   */
  _initialize() {
    if (this.isProducer) {
      // Initialize header with magic number
      Atomics.store(this.view, MEMORY_LAYOUT.CONTROL_OFFSET / 4, MEMORY_LAYOUT.MAGIC_NUMBER);
      Atomics.store(this.view, MEMORY_LAYOUT.WRITE_POS_OFFSET / 4, MEMORY_LAYOUT.HEADER_SIZE);
      Atomics.store(this.view, MEMORY_LAYOUT.READ_POS_OFFSET / 4, MEMORY_LAYOUT.HEADER_SIZE);
      Atomics.store(this.view, MEMORY_LAYOUT.EVENT_COUNT_OFFSET / 4, 0);
      Atomics.store(this.view, (MEMORY_LAYOUT.EVENT_COUNT_OFFSET + 4) / 4, 0);
      Atomics.store(this.view, MEMORY_LAYOUT.BUFFER_SIZE_OFFSET / 4, this.buffer.byteLength);
      
      // Set ready flag
      Atomics.or(this.view, MEMORY_LAYOUT.CONTROL_OFFSET / 4 + 1, CONTROL_FLAGS.READY);
    }
    
    this.isReady = true;
  }

  /**
   * Check if buffer is valid and ready
   * @returns {boolean}
   */
  isValid() {
    const magic = Atomics.load(this.view, MEMORY_LAYOUT.CONTROL_OFFSET / 4);
    const flags = Atomics.load(this.view, MEMORY_LAYOUT.CONTROL_OFFSET / 4 + 1);
    
    return magic === MEMORY_LAYOUT.MAGIC_NUMBER && (flags & CONTROL_FLAGS.READY) !== 0;
  }

  /**
   * Get current buffer statistics
   * @returns {Object}
   */
  getStats() {
    if (!this.isValid()) return null;

    const writePos = Atomics.load(this.view, MEMORY_LAYOUT.WRITE_POS_OFFSET / 4);
    const readPos = Atomics.load(this.view, MEMORY_LAYOUT.READ_POS_OFFSET / 4);
    const eventCountLow = Atomics.load(this.view, MEMORY_LAYOUT.EVENT_COUNT_OFFSET / 4);
    const eventCountHigh = Atomics.load(this.view, (MEMORY_LAYOUT.EVENT_COUNT_OFFSET + 4) / 4);
    const bufferSize = Atomics.load(this.view, MEMORY_LAYOUT.BUFFER_SIZE_OFFSET / 4);

    const pendingBytes = writePos >= readPos ? writePos - readPos : 
                        (bufferSize - MEMORY_LAYOUT.HEADER_SIZE) - (readPos - writePos);

    return {
      bufferSize,
      writePosition: writePos,
      readPosition: readPos,
      pendingBytes,
      utilization: (pendingBytes / (bufferSize - MEMORY_LAYOUT.HEADER_SIZE) * 100).toFixed(1),
      totalEvents: (eventCountHigh << 32) | eventCountLow,
      isReady: this.isReady,
    };
  }

  /**
   * Abstract methods to be implemented by subclasses
   */
  read() { throw new Error('Must implement read method'); }
  write() { throw new Error('Must implement write method'); }
}

/**
 * Producer class for writing events to SharedArrayBuffer
 * Implements Single Responsibility Principle
 */
class SharedBufferProducer extends SharedBufferInterface {
  constructor(buffer) {
    super(buffer, true);
    this._initialize();
    this.writeBuffer = new ArrayBuffer(MEMORY_LAYOUT.MAX_EVENT_SIZE);
    this.writeView = new DataView(this.writeBuffer);
  }

  /**
   * Write a file event to the shared buffer
   * @param {Object} event - File system event
   * @returns {boolean} Success status
   */
  write(event) {
    if (!this.isValid()) return false;

    try {
      // Serialize event to write buffer
      const serialized = this._serializeEvent(event);
      if (!serialized) return false;

      // Get available space and positions
      const bufferSize = Atomics.load(this.view, MEMORY_LAYOUT.BUFFER_SIZE_OFFSET / 4);
      const writePos = Atomics.load(this.view, MEMORY_LAYOUT.WRITE_POS_OFFSET / 4);
      const readPos = Atomics.load(this.view, MEMORY_LAYOUT.READ_POS_OFFSET / 4);
      
      const availableSpace = this._getAvailableSpace(writePos, readPos, bufferSize);
      const eventSize = serialized.byteLength + 4; // +4 for length prefix

      if (eventSize > availableSpace) {
        return false; // Buffer full
      }

      // Set writing flag
      Atomics.or(this.view, MEMORY_LAYOUT.CONTROL_OFFSET / 4 + 1, CONTROL_FLAGS.WRITING);

      // Write event length
      const lengthPos = writePos;
      this.byteView[lengthPos] = eventSize & 0xFF;
      this.byteView[lengthPos + 1] = (eventSize >> 8) & 0xFF;
      this.byteView[lengthPos + 2] = (eventSize >> 16) & 0xFF;
      this.byteView[lengthPos + 3] = (eventSize >> 24) & 0xFF;

      // Write event data
      const dataPos = lengthPos + 4;
      this.byteView.set(new Uint8Array(serialized), dataPos);

      // Update write position atomically
      const newWritePos = (writePos + eventSize) % (bufferSize - MEMORY_LAYOUT.HEADER_SIZE) + MEMORY_LAYOUT.HEADER_SIZE;
      Atomics.store(this.view, MEMORY_LAYOUT.WRITE_POS_OFFSET / 4, newWritePos);

      // Increment event counter
      this._incrementEventCounter();

      // Clear writing flag
      Atomics.and(this.view, MEMORY_LAYOUT.CONTROL_OFFSET / 4 + 1, ~CONTROL_FLAGS.WRITING);

      return true;

    } catch (error) {
      // Set error flag and clear writing flag
      Atomics.or(this.view, MEMORY_LAYOUT.CONTROL_OFFSET / 4 + 1, CONTROL_FLAGS.ERROR);
      Atomics.and(this.view, MEMORY_LAYOUT.CONTROL_OFFSET / 4 + 1, ~CONTROL_FLAGS.WRITING);
      return false;
    }
  }

  /**
   * Serialize file event to binary format
   * @param {Object} event - File event
   * @returns {ArrayBuffer|null} Serialized data
   * @private
   */
  _serializeEvent(event) {
    try {
      const jsonStr = JSON.stringify({
        path: event.path || '',
        event_type: event.event_type || 'modified',
        timestamp: event.timestamp || Date.now().toString(),
        size: event.size || '0',
        is_directory: event.is_directory || false,
        hash: event.hash || null,
      });

      const encoder = new TextEncoder();
      return encoder.encode(jsonStr).buffer;

    } catch (error) {
      return null;
    }
  }

  /**
   * Calculate available space in circular buffer
   * @private
   */
  _getAvailableSpace(writePos, readPos, bufferSize) {
    const dataSize = bufferSize - MEMORY_LAYOUT.HEADER_SIZE;
    
    if (writePos >= readPos) {
      return dataSize - (writePos - readPos) - MEMORY_LAYOUT.HEADER_SIZE;
    } else {
      return readPos - writePos - MEMORY_LAYOUT.HEADER_SIZE;
    }
  }

  /**
   * Atomically increment the event counter
   * @private
   */
  _incrementEventCounter() {
    // 64-bit atomic increment (low, then high if overflow)
    const oldLow = Atomics.add(this.view, MEMORY_LAYOUT.EVENT_COUNT_OFFSET / 4, 1);
    if (oldLow === 0xFFFFFFFF) {
      Atomics.add(this.view, (MEMORY_LAYOUT.EVENT_COUNT_OFFSET + 4) / 4, 1);
    }
  }
}

/**
 * Consumer class for reading events from SharedArrayBuffer  
 * Implements Single Responsibility Principle
 */
class SharedBufferConsumer extends SharedBufferInterface {
  constructor(buffer) {
    super(buffer, false);
    this.readBuffer = new ArrayBuffer(MEMORY_LAYOUT.MAX_EVENT_SIZE);
    this.readView = new DataView(this.readBuffer);
  }

  /**
   * Read the next available event from the buffer
   * @returns {Object|null} File event or null if no events
   */
  read() {
    if (!this.isValid()) return null;

    try {
      // Set reading flag
      Atomics.or(this.view, MEMORY_LAYOUT.CONTROL_OFFSET / 4 + 1, CONTROL_FLAGS.READING);

      const bufferSize = Atomics.load(this.view, MEMORY_LAYOUT.BUFFER_SIZE_OFFSET / 4);
      const writePos = Atomics.load(this.view, MEMORY_LAYOUT.WRITE_POS_OFFSET / 4);
      const readPos = Atomics.load(this.view, MEMORY_LAYOUT.READ_POS_OFFSET / 4);

      // Check if data is available
      if (readPos === writePos) {
        Atomics.and(this.view, MEMORY_LAYOUT.CONTROL_OFFSET / 4 + 1, ~CONTROL_FLAGS.READING);
        return null; // No data available
      }

      // Read event length
      const lengthBytes = [
        this.byteView[readPos],
        this.byteView[readPos + 1],
        this.byteView[readPos + 2],
        this.byteView[readPos + 3]
      ];
      const eventSize = lengthBytes[0] | (lengthBytes[1] << 8) | (lengthBytes[2] << 16) | (lengthBytes[3] << 24);

      if (eventSize < 4 || eventSize > MEMORY_LAYOUT.MAX_EVENT_SIZE) {
        // Corrupted data, reset read position
        Atomics.store(this.view, MEMORY_LAYOUT.READ_POS_OFFSET / 4, writePos);
        Atomics.and(this.view, MEMORY_LAYOUT.CONTROL_OFFSET / 4 + 1, ~CONTROL_FLAGS.READING);
        return null;
      }

      // Read event data
      const dataStart = readPos + 4;
      const eventData = this.byteView.slice(dataStart, dataStart + eventSize - 4);

      // Update read position
      const newReadPos = (readPos + eventSize) % (bufferSize - MEMORY_LAYOUT.HEADER_SIZE) + MEMORY_LAYOUT.HEADER_SIZE;
      Atomics.store(this.view, MEMORY_LAYOUT.READ_POS_OFFSET / 4, newReadPos);

      // Clear reading flag
      Atomics.and(this.view, MEMORY_LAYOUT.CONTROL_OFFSET / 4 + 1, ~CONTROL_FLAGS.READING);

      // Deserialize event
      return this._deserializeEvent(eventData);

    } catch (error) {
      // Set error flag and clear reading flag
      Atomics.or(this.view, MEMORY_LAYOUT.CONTROL_OFFSET / 4 + 1, CONTROL_FLAGS.ERROR);
      Atomics.and(this.view, MEMORY_LAYOUT.CONTROL_OFFSET / 4 + 1, ~CONTROL_FLAGS.READING);
      return null;
    }
  }

  /**
   * Deserialize binary data to file event
   * @param {Uint8Array} data - Serialized data
   * @returns {Object|null} File event
   * @private
   */
  _deserializeEvent(data) {
    try {
      const decoder = new TextDecoder();
      const jsonStr = decoder.decode(data);
      return JSON.parse(jsonStr);
    } catch (error) {
      return null;
    }
  }
}

/**
 * Zero-Copy IPC Communication Manager
 * Direct connection to Rust daemon using memory-mapped files
 */
class SharedBufferCommunicator extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.options = {
      mmapPath: options.mmapPath || '/tmp/retrigger-ipc.mmap',
      pollIntervalMs: options.pollIntervalMs || 1,
      reconnectIntervalMs: options.reconnectIntervalMs || 5000,
      maxReconnectAttempts: options.maxReconnectAttempts || 10,
      enableAutoReconnect: options.enableAutoReconnect !== false,
      ...options,
    };
    
    // State
    this.bridge = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    
    // Performance monitoring
    this.performanceStats = {
      eventsReceived: 0,
      bytesTransferred: 0,
      averageLatency: 0,
      connectionUptime: 0,
      lastEventTime: 0,
      errorCount: 0,
    };
    
    // Create the IPC bridge
    this.bridge = new RustIPCBridge(this.options.mmapPath);
    this._setupBridgeEvents();
  }

  /**
   * Setup event handlers for the IPC bridge
   * @private
   */
  _setupBridgeEvents() {
    // Connection events
    this.bridge.on('connected', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.performanceStats.connectionUptime = Date.now();
      
      console.log('Connected to Rust daemon IPC');
      this.emit('connected');
    });

    this.bridge.on('disconnected', () => {
      this.isConnected = false;
      console.log('Disconnected from Rust daemon IPC');
      this.emit('disconnected');
      
      if (this.options.enableAutoReconnect) {
        this._scheduleReconnect();
      }
    });

    // File events
    this.bridge.on('file-event', (event) => {
      this.performanceStats.eventsReceived++;
      this.performanceStats.lastEventTime = Date.now();
      
      // Calculate approximate bytes transferred
      this.performanceStats.bytesTransferred += 
        (event.path.length + 100); // Rough estimate
      
      this.emit('file-event', event);
    });

    this.bridge.on('batch-processed', (count) => {
      this.emit('batch-processed', count);
    });

    // System events
    this.bridge.on('shutdown', () => {
      console.log('Rust daemon shutdown detected');
      this.emit('daemon-shutdown');
      this.disconnect();
    });

    // Error handling
    this.bridge.on('error', (error) => {
      this.performanceStats.errorCount++;
      console.error('IPC Bridge error:', error);
      this.emit('error', error);
      
      if (this.options.enableAutoReconnect && !this.isConnected) {
        this._scheduleReconnect();
      }
    });
  }

  /**
   * Initialize connection to Rust daemon (main method)
   * @returns {Promise<void>}
   */
  async initializeAsMain() {
    console.log('Initializing zero-copy IPC connection to Rust daemon...');
    
    try {
      await this.bridge.connect();
      this.bridge.startPolling(this.options.pollIntervalMs);
      
      console.log('Zero-copy IPC initialized successfully');
    } catch (error) {
      console.error('Failed to initialize IPC:', error);
      
      if (this.options.enableAutoReconnect) {
        this._scheduleReconnect();
      } else {
        throw error;
      }
    }
  }

  /**
   * Legacy method for compatibility - now connects to daemon
   * @param {SharedArrayBuffer} _ - Ignored (legacy parameter)
   */
  initializeAsWorker(_) {
    console.log('Legacy worker initialization - connecting to daemon instead');
    return this.initializeAsMain();
  }

  /**
   * Write event - Not supported (Rust daemon is producer)
   * @param {Object} event - File system event
   * @returns {boolean} Always false
   */
  writeEvent(event) {
    console.warn('writeEvent not supported - Rust daemon is the producer');
    return false;
  }

  /**
   * Disconnect from the Rust daemon
   */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.bridge) {
      this.bridge.disconnect();
    }
    
    this.isConnected = false;
    this.reconnectAttempts = 0;
  }

  /**
   * Legacy destroy method - now calls disconnect
   */
  destroy() {
    this.disconnect();
    this.removeAllListeners();
  }

  /**
   * Schedule reconnection attempt
   * @private
   */
  _scheduleReconnect() {
    if (this.reconnectTimer || this.isConnected) return;
    
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      console.error(`Max reconnection attempts (${this.options.maxReconnectAttempts}) exceeded`);
      this.emit('max-reconnect-attempts-exceeded');
      return;
    }
    
    const delay = Math.min(
      this.options.reconnectIntervalMs * Math.pow(2, this.reconnectAttempts),
      30000 // Max 30 seconds
    );
    
    this.reconnectAttempts++;
    console.log(`Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);
    
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      
      try {
        console.log(`Reconnection attempt ${this.reconnectAttempts}/${this.options.maxReconnectAttempts}`);
        await this.initializeAsMain();
      } catch (error) {
        console.error('Reconnection failed:', error);
        this._scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Get comprehensive communication statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    const bridgeStats = this.bridge ? this.bridge.getStats() : {};
    const uptime = this.performanceStats.connectionUptime ? 
      Date.now() - this.performanceStats.connectionUptime : 0;
    
    return {
      // Connection status
      connected: this.isConnected,
      mmapPath: this.options.mmapPath,
      reconnectAttempts: this.reconnectAttempts,
      
      // Performance metrics
      eventsReceived: this.performanceStats.eventsReceived,
      bytesTransferred: this.performanceStats.bytesTransferred,
      averageLatency: this.performanceStats.averageLatency,
      lastEventTime: this.performanceStats.lastEventTime,
      errorCount: this.performanceStats.errorCount,
      uptime,
      
      // Throughput calculations
      eventsPerSecond: uptime > 0 ? 
        (this.performanceStats.eventsReceived / (uptime / 1000)).toFixed(2) : 0,
      
      // Bridge statistics
      bridge: bridgeStats,
      
      // Configuration
      options: {
        pollIntervalMs: this.options.pollIntervalMs,
        reconnectIntervalMs: this.options.reconnectIntervalMs,
        maxReconnectAttempts: this.options.maxReconnectAttempts,
        enableAutoReconnect: this.options.enableAutoReconnect,
      },
    };
  }

  /**
   * Check if daemon is alive and responsive
   * @returns {boolean}
   */
  isDaemonAlive() {
    return this.bridge ? this.bridge.isDaemonAlive() : false;
  }

  /**
   * Force reconnection
   * @returns {Promise<void>}
   */
  async forceReconnect() {
    this.disconnect();
    this.reconnectAttempts = 0;
    await this.initializeAsMain();
  }

  /**
   * Get the underlying IPC bridge for advanced operations
   * @returns {RustIPCBridge}
   */
  getBridge() {
    return this.bridge;
  }
}

module.exports = {
  SharedBufferCommunicator,
  RustIPCBridge: require('./ipc-bridge').RustIPCBridge,
  
  // Legacy exports for backward compatibility
  SharedBufferProducer,
  SharedBufferConsumer,
  SharedBufferInterface,
  MEMORY_LAYOUT,
  CONTROL_FLAGS,
};
