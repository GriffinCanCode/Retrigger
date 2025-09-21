/**
 * Performance Monitor & Memory Management System
 * 
 * Advanced performance monitoring, memory management, and optimization features
 * for production deployments of Retrigger Node.js integration.
 * 
 * Features:
 * - Real-time performance metrics collection
 * - Memory usage monitoring and leak detection  
 * - Adaptive resource management
 * - Performance bottleneck identification
 * - Automatic optimization recommendations
 * - Production-ready alerting system
 */

const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');

/**
 * Main Performance Monitor class
 * Implements comprehensive monitoring with SOLID principles
 */
class PerformanceMonitor extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      // Monitoring intervals (ms)
      metricsInterval: options.metricsInterval || 1000,
      memoryCheckInterval: options.memoryCheckInterval || 5000,
      gcAnalysisInterval: options.gcAnalysisInterval || 10000,
      
      // Thresholds for alerts
      memoryThreshold: options.memoryThreshold || 0.85, // 85% of heap limit
      cpuThreshold: options.cpuThreshold || 0.8, // 80% CPU usage
      eventLatencyThreshold: options.eventLatencyThreshold || 100, // 100ms
      
      // Feature flags
      enableMemoryLeakDetection: options.enableMemoryLeakDetection !== false,
      enableGCAnalysis: options.enableGCAnalysis !== false,
      enableAdaptiveOptimization: options.enableAdaptiveOptimization !== false,
      enableAlerting: options.enableAlerting !== false,
      
      // History settings
      maxHistorySize: options.maxHistorySize || 1000,
      metricsRetentionMs: options.metricsRetentionMs || 24 * 60 * 60 * 1000, // 24 hours
      
      verbose: options.verbose || false,
      ...options,
    };

    // Core components
    this.metricsCollector = new MetricsCollector(this.options);
    this.memoryManager = new MemoryManager(this.options);
    this.performanceAnalyzer = new PerformanceAnalyzer(this.options);
    this.adaptiveOptimizer = new AdaptiveOptimizer(this.options);
    this.alertSystem = new AlertSystem(this.options);
    
    // State
    this.isMonitoring = false;
    this.intervals = {};
    this.startTime = Date.now();
    
    // Bind event handlers
    this.setupEventHandlers();
  }

  /**
   * Initialize and start performance monitoring
   */
  async initialize() {
    if (this.isMonitoring) return;

    if (this.options.verbose) {
      console.log('[PerformanceMonitor] Initializing comprehensive monitoring system');
    }

    // Initialize components
    await this.metricsCollector.initialize();
    await this.memoryManager.initialize();
    await this.performanceAnalyzer.initialize();
    
    if (this.options.enableAdaptiveOptimization) {
      await this.adaptiveOptimizer.initialize();
    }

    if (this.options.enableAlerting) {
      await this.alertSystem.initialize();
    }

    // Start monitoring intervals
    this.startMonitoring();
    
    this.emit('initialized');
    return true;
  }

  /**
   * Start all monitoring intervals
   * @private
   */
  startMonitoring() {
    this.isMonitoring = true;

    // Core metrics collection
    this.intervals.metrics = setInterval(() => {
      this.collectMetrics();
    }, this.options.metricsInterval);

    // Memory monitoring
    this.intervals.memory = setInterval(() => {
      this.checkMemoryUsage();
    }, this.options.memoryCheckInterval);

    // GC analysis
    if (this.options.enableGCAnalysis) {
      this.intervals.gc = setInterval(() => {
        this.analyzeGarbageCollection();
      }, this.options.gcAnalysisInterval);
    }

    if (this.options.verbose) {
      console.log('[PerformanceMonitor] Started monitoring with intervals:', {
        metrics: this.options.metricsInterval,
        memory: this.options.memoryCheckInterval,
        gc: this.options.gcAnalysisInterval,
      });
    }
  }

  /**
   * Collect current performance metrics (optimized for hot reload)
   * @private
   */
  async collectMetrics() {
    try {
      // Lightweight metrics collection during hot reload activity
      const metrics = await this.metricsCollector.collectLightweight();
      
      // Store metrics asynchronously
      setImmediate(() => {
        this.performanceAnalyzer.addMetrics(metrics);
      });
      
      // Skip heavy analysis during high-activity periods (hot reload)
      const isHighActivity = metrics.events.events_per_second > 5;
      
      if (!isHighActivity) {
        // Only do full analysis during low activity
        const issues = this.performanceAnalyzer.analyzeLatestMetrics(metrics);
        
        if (issues.length > 0) {
          this.emit('performance-issues', issues);
          
          if (this.options.enableAlerting) {
            setImmediate(() => {
              this.alertSystem.handlePerformanceIssues(issues);
            });
          }
        }

        // Adaptive optimization only during low activity
        if (this.options.enableAdaptiveOptimization) {
          setImmediate(async () => {
            try {
              const optimizations = await this.adaptiveOptimizer.suggestOptimizations(metrics);
              if (optimizations.length > 0) {
                this.emit('optimization-suggestions', optimizations);
              }
            } catch (error) {
              // Ignore optimization errors during hot reload
            }
          });
        }
      }

      this.emit('metrics-collected', metrics);

    } catch (error) {
      this.emit('error', new Error(`Failed to collect metrics: ${error.message}`));
    }
  }

  /**
   * Check memory usage and detect potential leaks
   * @private
   */
  async checkMemoryUsage() {
    try {
      const memoryInfo = await this.memoryManager.analyzeMemoryUsage();
      
      // Check for memory threshold violations
      if (memoryInfo.heapUtilization > this.options.memoryThreshold) {
        this.emit('memory-threshold-exceeded', memoryInfo);
        
        if (this.options.enableAlerting) {
          this.alertSystem.handleMemoryAlert(memoryInfo);
        }
      }

      // Memory leak detection
      if (this.options.enableMemoryLeakDetection) {
        const leakAnalysis = await this.memoryManager.detectMemoryLeaks();
        
        if (leakAnalysis.suspected) {
          this.emit('memory-leak-suspected', leakAnalysis);
          
          if (this.options.enableAlerting) {
            this.alertSystem.handleMemoryLeakAlert(leakAnalysis);
          }
        }
      }

      this.emit('memory-checked', memoryInfo);

    } catch (error) {
      this.emit('error', new Error(`Memory check failed: ${error.message}`));
    }
  }

  /**
   * Analyze garbage collection patterns
   * @private
   */
  async analyzeGarbageCollection() {
    try {
      const gcAnalysis = await this.memoryManager.analyzeGC();
      
      if (gcAnalysis.issues.length > 0) {
        this.emit('gc-issues', gcAnalysis);
        
        if (this.options.enableAlerting) {
          this.alertSystem.handleGCAlert(gcAnalysis);
        }
      }

      this.emit('gc-analyzed', gcAnalysis);

    } catch (error) {
      this.emit('error', new Error(`GC analysis failed: ${error.message}`));
    }
  }

  /**
   * Record a file system event for performance analysis (optimized)
   * @param {Object} event - File system event
   */
  recordEvent(event) {
    // Fast path: Only record critical metrics during active development
    const eventMetrics = {
      timestamp: Date.now(),
      type: event.event_type || 'unknown',
      path: event.path || 'unknown',
      latency: event.latency || 0,
    };

    // Add to metrics asynchronously to avoid blocking hot reload
    setImmediate(() => {
      this.metricsCollector.addEventMetric(eventMetrics);
      
      // Check for latency issues only if monitoring is active
      if (this.isMonitoring && eventMetrics.latency > this.options.eventLatencyThreshold) {
        this.emit('high-latency-event', eventMetrics);
      }
    });
  }

  /**
   * Get comprehensive performance report
   * @returns {Object} Performance report
   */
  getPerformanceReport() {
    const uptime = Date.now() - this.startTime;
    
    return {
      system: {
        uptime_ms: uptime,
        uptime_human: this.formatDuration(uptime),
        monitoring_active: this.isMonitoring,
        start_time: this.startTime,
      },
      
      current_metrics: this.metricsCollector.getCurrentMetrics(),
      memory: this.memoryManager.getCurrentMemoryInfo(),
      performance_analysis: this.performanceAnalyzer.getLatestAnalysis(),
      
      optimization_suggestions: this.options.enableAdaptiveOptimization 
        ? this.adaptiveOptimizer.getLatestSuggestions() 
        : null,
        
      alerts: this.options.enableAlerting 
        ? this.alertSystem.getRecentAlerts() 
        : null,
        
      configuration: this.options,
    };
  }

  /**
   * Get real-time dashboard data
   * @returns {Object} Dashboard data
   */
  getDashboardData() {
    const metrics = this.metricsCollector.getCurrentMetrics();
    const memoryInfo = this.memoryManager.getCurrentMemoryInfo();
    const analysis = this.performanceAnalyzer.getLatestAnalysis();

    return {
      timestamp: Date.now(),
      
      // Key metrics
      metrics: {
        cpu_usage: metrics.cpu_usage,
        memory_usage: memoryInfo.heapUtilization,
        event_rate: metrics.events_per_second,
        average_latency: metrics.average_event_latency,
      },

      // Status indicators
      status: {
        overall: this.getOverallStatus(metrics, memoryInfo, analysis),
        memory: memoryInfo.heapUtilization < this.options.memoryThreshold ? 'healthy' : 'warning',
        performance: analysis.performance_score > 0.8 ? 'excellent' : 
                    analysis.performance_score > 0.6 ? 'good' : 'needs_attention',
      },

      // Recent issues
      recent_issues: analysis.recent_issues || [],
      
      // Trends (last hour)
      trends: this.performanceAnalyzer.getTrends(60 * 60 * 1000), // 1 hour
    };
  }

  /**
   * Force garbage collection (if available)
   * @returns {boolean} Whether GC was triggered
   */
  forceGarbageCollection() {
    try {
      if (global.gc) {
        global.gc();
        this.emit('gc-forced');
        return true;
      } else {
        this.emit('warning', 'Garbage collection not available (run with --expose-gc)');
        return false;
      }
    } catch (error) {
      this.emit('error', new Error(`Failed to force GC: ${error.message}`));
      return false;
    }
  }

  /**
   * Setup event handlers for component communication
   * @private
   */
  setupEventHandlers() {
    // Memory manager events
    this.memoryManager.on('memory-pressure', (info) => {
      this.emit('memory-pressure', info);
      
      // Auto-trigger GC if available and pressure is high
      if (info.pressure_level === 'critical') {
        this.forceGarbageCollection();
      }
    });

    // Performance analyzer events
    this.performanceAnalyzer.on('performance-degraded', (analysis) => {
      this.emit('performance-degraded', analysis);
    });

    // Adaptive optimizer events
    if (this.options.enableAdaptiveOptimization) {
      this.adaptiveOptimizer.on('optimization-applied', (optimization) => {
        this.emit('optimization-applied', optimization);
      });
    }
  }

  /**
   * Get overall system status
   * @param {Object} metrics - Current metrics
   * @param {Object} memoryInfo - Memory information
   * @param {Object} analysis - Performance analysis
   * @returns {string} Status string
   * @private
   */
  getOverallStatus(metrics, memoryInfo, analysis) {
    const issues = [];

    if (memoryInfo.heapUtilization > this.options.memoryThreshold) {
      issues.push('high-memory');
    }

    if (metrics.cpu_usage > this.options.cpuThreshold) {
      issues.push('high-cpu');
    }

    if (metrics.average_event_latency > this.options.eventLatencyThreshold) {
      issues.push('high-latency');
    }

    if (issues.length === 0) return 'healthy';
    if (issues.length === 1) return 'warning';
    return 'critical';
  }

  /**
   * Format duration in human-readable format
   * @param {number} ms - Milliseconds
   * @returns {string} Formatted duration
   * @private
   */
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  /**
   * Stop monitoring and cleanup
   */
  destroy() {
    if (this.options.verbose) {
      console.log('[PerformanceMonitor] Shutting down monitoring system');
    }

    this.isMonitoring = false;

    // Clear intervals
    Object.values(this.intervals).forEach(interval => {
      clearInterval(interval);
    });
    this.intervals = {};

    // Cleanup components
    this.metricsCollector.destroy();
    this.memoryManager.destroy();
    this.performanceAnalyzer.destroy();
    
    if (this.adaptiveOptimizer) {
      this.adaptiveOptimizer.destroy();
    }
    
    if (this.alertSystem) {
      this.alertSystem.destroy();
    }

    this.removeAllListeners();
    this.emit('destroyed');
  }
}

/**
 * Metrics Collector - Gathers performance metrics
 */
class MetricsCollector {
  constructor(options) {
    this.options = options;
    this.eventMetrics = [];
    this.systemMetrics = [];
    this.lastCpuUsage = process.cpuUsage();
    this.lastMetricsTime = Date.now();
  }

  async initialize() {
    // Initialize baseline metrics
    this.baselineMetrics = await this.collectSystemMetrics();
  }

  async collect() {
    const systemMetrics = await this.collectSystemMetrics();
    const eventMetrics = this.getEventMetrics();
    
    const combined = {
      timestamp: Date.now(),
      system: systemMetrics,
      events: eventMetrics,
      process: this.getProcessMetrics(),
    };

    // Store in history
    this.systemMetrics.push(combined);
    
    // Trim history
    if (this.systemMetrics.length > this.options.maxHistorySize) {
      this.systemMetrics.shift();
    }

    return combined;
  }

  /**
   * Lightweight metrics collection for hot reload periods
   * @returns {Object} Lightweight metrics
   */
  async collectLightweight() {
    // Only collect essential metrics during hot reload
    const memoryUsage = process.memoryUsage();
    const eventMetrics = this.getEventMetrics();
    
    const lightweight = {
      timestamp: Date.now(),
      system: {
        memory: memoryUsage,
        heap_utilization: memoryUsage.heapUsed / memoryUsage.heapTotal,
        // Skip CPU measurement to reduce overhead
        cpu_usage: 0,
      },
      events: eventMetrics,
      // Skip process metrics during hot reload
      process: null,
    };

    // Don't store in full history during hot reload
    return lightweight;
  }

  async collectSystemMetrics() {
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage(this.lastCpuUsage);
    const now = Date.now();
    const timeDelta = now - this.lastMetricsTime;

    // Calculate CPU usage percentage
    const cpuPercent = timeDelta > 0 
      ? ((cpuUsage.user + cpuUsage.system) / 1000) / timeDelta
      : 0;

    this.lastCpuUsage = process.cpuUsage();
    this.lastMetricsTime = now;

    return {
      memory: memoryUsage,
      cpu_usage: Math.min(cpuPercent, 1), // Cap at 100%
      heap_utilization: memoryUsage.heapUsed / memoryUsage.heapTotal,
      uptime: process.uptime(),
      load_average: require('os').loadavg(),
    };
  }

  getEventMetrics() {
    const recentEvents = this.eventMetrics.filter(
      event => Date.now() - event.timestamp < 60000 // Last minute
    );

    if (recentEvents.length === 0) {
      return {
        events_per_second: 0,
        average_event_latency: 0,
        total_events: this.eventMetrics.length,
      };
    }

    const averageLatency = recentEvents.reduce((sum, event) => sum + event.latency, 0) / recentEvents.length;
    const eventsPerSecond = recentEvents.length / 60; // Per minute / 60

    return {
      events_per_second: eventsPerSecond,
      average_event_latency: averageLatency,
      total_events: this.eventMetrics.length,
      recent_events: recentEvents.length,
    };
  }

  getProcessMetrics() {
    return {
      pid: process.pid,
      version: process.version,
      platform: process.platform,
      arch: process.arch,
    };
  }

  addEventMetric(eventMetric) {
    this.eventMetrics.push(eventMetric);
    
    // Trim old events
    const cutoff = Date.now() - this.options.metricsRetentionMs;
    this.eventMetrics = this.eventMetrics.filter(event => event.timestamp > cutoff);
  }

  getCurrentMetrics() {
    return this.systemMetrics.length > 0 
      ? this.systemMetrics[this.systemMetrics.length - 1] 
      : null;
  }

  destroy() {
    this.eventMetrics = [];
    this.systemMetrics = [];
  }
}

/**
 * Memory Manager - Advanced memory monitoring and management
 */
class MemoryManager extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.memoryHistory = [];
    this.gcHistory = [];
  }

  async initialize() {
    // Setup GC event monitoring if available
    if (this.options.enableGCAnalysis && process.versions.v8) {
      this.setupGCMonitoring();
    }
  }

  async analyzeMemoryUsage() {
    const memoryUsage = process.memoryUsage();
    const heapStats = require('v8').getHeapStatistics();
    
    const memoryInfo = {
      timestamp: Date.now(),
      heap_used: memoryUsage.heapUsed,
      heap_total: memoryUsage.heapTotal,
      heap_limit: heapStats.heap_size_limit,
      heapUtilization: memoryUsage.heapUsed / heapStats.heap_size_limit,
      external: memoryUsage.external,
      array_buffers: memoryUsage.arrayBuffers,
      
      // V8 heap statistics
      total_heap_size: heapStats.total_heap_size,
      used_heap_size: heapStats.used_heap_size,
      total_available_size: heapStats.total_available_size,
      malloced_memory: heapStats.malloced_memory,
      peak_malloced_memory: heapStats.peak_malloced_memory,
    };

    // Store in history
    this.memoryHistory.push(memoryInfo);
    
    // Trim history
    if (this.memoryHistory.length > this.options.maxHistorySize) {
      this.memoryHistory.shift();
    }

    // Check for memory pressure
    this.checkMemoryPressure(memoryInfo);

    return memoryInfo;
  }

  async detectMemoryLeaks() {
    if (this.memoryHistory.length < 10) {
      return { suspected: false, reason: 'insufficient-data' };
    }

    const recent = this.memoryHistory.slice(-10);
    const growthRate = this.calculateMemoryGrowthRate(recent);
    
    // Detect consistent upward trend
    const isSuspicious = growthRate > 0.1 && // 10% growth rate
                        recent.every((sample, i) => 
                          i === 0 || sample.heap_used >= recent[i-1].heap_used
                        );

    return {
      suspected: isSuspicious,
      growth_rate: growthRate,
      trend: this.analyzeMemoryTrend(recent),
      recommendation: isSuspicious ? 'Consider investigating potential memory leaks' : null,
    };
  }

  calculateMemoryGrowthRate(samples) {
    if (samples.length < 2) return 0;
    
    const first = samples[0].heap_used;
    const last = samples[samples.length - 1].heap_used;
    const timeDiff = samples[samples.length - 1].timestamp - samples[0].timestamp;
    
    return timeDiff > 0 ? (last - first) / first : 0;
  }

  analyzeMemoryTrend(samples) {
    // Simple linear regression to detect trend
    const n = samples.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    
    samples.forEach((sample, i) => {
      sumX += i;
      sumY += sample.heap_used;
      sumXY += i * sample.heap_used;
      sumXX += i * i;
    });
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    
    if (slope > 1000000) return 'increasing'; // 1MB+ per sample
    if (slope < -1000000) return 'decreasing';
    return 'stable';
  }

  checkMemoryPressure(memoryInfo) {
    const pressureThresholds = {
      warning: 0.7,   // 70%
      critical: 0.9,  // 90%
    };

    let pressureLevel = 'normal';
    
    if (memoryInfo.heapUtilization > pressureThresholds.critical) {
      pressureLevel = 'critical';
    } else if (memoryInfo.heapUtilization > pressureThresholds.warning) {
      pressureLevel = 'warning';
    }

    if (pressureLevel !== 'normal') {
      this.emit('memory-pressure', {
        ...memoryInfo,
        pressure_level: pressureLevel,
      });
    }
  }

  setupGCMonitoring() {
    // This would require native bindings or additional modules
    // For now, we'll simulate GC monitoring
    if (this.options.verbose) {
      console.log('[MemoryManager] GC monitoring setup (simulated)');
    }
  }

  async analyzeGC() {
    // Placeholder for GC analysis
    return {
      timestamp: Date.now(),
      gc_events: this.gcHistory.length,
      issues: [],
      recommendations: [],
    };
  }

  getCurrentMemoryInfo() {
    return this.memoryHistory.length > 0 
      ? this.memoryHistory[this.memoryHistory.length - 1]
      : null;
  }

  destroy() {
    this.memoryHistory = [];
    this.gcHistory = [];
    this.removeAllListeners();
  }
}

/**
 * Performance Analyzer - Analyzes performance patterns and issues
 */
class PerformanceAnalyzer {
  constructor(options) {
    this.options = options;
    this.analysisHistory = [];
    this.performanceBaseline = null;
  }

  async initialize() {
    // Establish performance baseline
    this.performanceBaseline = {
      memory_usage: 0.1, // 10% baseline
      cpu_usage: 0.05,   // 5% baseline
      event_latency: 10, // 10ms baseline
    };
  }

  addMetrics(metrics) {
    const analysis = this.analyzeMetrics(metrics);
    this.analysisHistory.push(analysis);
    
    // Trim history
    if (this.analysisHistory.length > this.options.maxHistorySize) {
      this.analysisHistory.shift();
    }
  }

  analyzeMetrics(metrics) {
    const issues = [];
    const recommendations = [];
    
    // CPU analysis
    if (metrics.system.cpu_usage > this.options.cpuThreshold) {
      issues.push({
        type: 'high-cpu',
        severity: 'warning',
        value: metrics.system.cpu_usage,
        threshold: this.options.cpuThreshold,
      });
      
      recommendations.push('Consider optimizing CPU-intensive operations');
    }

    // Memory analysis
    if (metrics.system.heap_utilization > this.options.memoryThreshold) {
      issues.push({
        type: 'high-memory',
        severity: 'warning',
        value: metrics.system.heap_utilization,
        threshold: this.options.memoryThreshold,
      });
      
      recommendations.push('Consider memory optimization or garbage collection tuning');
    }

    // Event latency analysis
    if (metrics.events.average_event_latency > this.options.eventLatencyThreshold) {
      issues.push({
        type: 'high-latency',
        severity: 'performance',
        value: metrics.events.average_event_latency,
        threshold: this.options.eventLatencyThreshold,
      });
      
      recommendations.push('Investigate file system event processing bottlenecks');
    }

    // Calculate performance score
    const performanceScore = this.calculatePerformanceScore(metrics);

    return {
      timestamp: metrics.timestamp,
      performance_score: performanceScore,
      issues,
      recommendations,
      metrics_summary: {
        cpu: metrics.system.cpu_usage,
        memory: metrics.system.heap_utilization,
        events_per_second: metrics.events.events_per_second,
        average_latency: metrics.events.average_event_latency,
      },
    };
  }

  calculatePerformanceScore(metrics) {
    // Weighted performance score (0-1, higher is better)
    const cpuScore = Math.max(0, 1 - (metrics.system.cpu_usage / this.options.cpuThreshold));
    const memoryScore = Math.max(0, 1 - (metrics.system.heap_utilization / this.options.memoryThreshold));
    const latencyScore = Math.max(0, 1 - (metrics.events.average_event_latency / this.options.eventLatencyThreshold));
    
    // Weighted average
    return (cpuScore * 0.3 + memoryScore * 0.4 + latencyScore * 0.3);
  }

  analyzeLatestMetrics(metrics) {
    const analysis = this.analyzeMetrics(metrics);
    return analysis.issues;
  }

  getLatestAnalysis() {
    return this.analysisHistory.length > 0 
      ? this.analysisHistory[this.analysisHistory.length - 1]
      : null;
  }

  getTrends(timeWindowMs) {
    const cutoff = Date.now() - timeWindowMs;
    const recentAnalysis = this.analysisHistory.filter(a => a.timestamp > cutoff);
    
    if (recentAnalysis.length < 2) {
      return { trend: 'insufficient-data' };
    }

    const scores = recentAnalysis.map(a => a.performance_score);
    const avgScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    
    const firstHalf = scores.slice(0, Math.floor(scores.length / 2));
    const secondHalf = scores.slice(Math.floor(scores.length / 2));
    
    const firstAvg = firstHalf.reduce((sum, score) => sum + score, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum, score) => sum + score, 0) / secondHalf.length;
    
    const trend = secondAvg > firstAvg + 0.1 ? 'improving' :
                 secondAvg < firstAvg - 0.1 ? 'degrading' : 'stable';

    return {
      trend,
      average_score: avgScore,
      recent_improvement: secondAvg - firstAvg,
      sample_count: recentAnalysis.length,
    };
  }

  destroy() {
    this.analysisHistory = [];
  }
}

/**
 * Adaptive Optimizer - Provides optimization suggestions
 */
class AdaptiveOptimizer extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.optimizationHistory = [];
  }

  async initialize() {
    if (this.options.verbose) {
      console.log('[AdaptiveOptimizer] Initialized adaptive optimization system');
    }
  }

  async suggestOptimizations(metrics) {
    const suggestions = [];
    
    // Memory optimizations
    if (metrics.system.heap_utilization > 0.8) {
      suggestions.push({
        type: 'memory',
        priority: 'high',
        suggestion: 'Enable aggressive garbage collection',
        implementation: 'gc-tuning',
        impact: 'medium',
      });
    }

    // CPU optimizations
    if (metrics.system.cpu_usage > 0.7) {
      suggestions.push({
        type: 'cpu',
        priority: 'medium',
        suggestion: 'Increase event debouncing interval',
        implementation: 'debounce-optimization',
        impact: 'low',
      });
    }

    // Event processing optimizations
    if (metrics.events.events_per_second > 100) {
      suggestions.push({
        type: 'events',
        priority: 'medium',
        suggestion: 'Enable SharedArrayBuffer for faster event processing',
        implementation: 'shared-buffer-optimization',
        impact: 'high',
      });
    }

    return suggestions;
  }

  getLatestSuggestions() {
    return this.optimizationHistory.slice(-10);
  }

  destroy() {
    this.optimizationHistory = [];
    this.removeAllListeners();
  }
}

/**
 * Alert System - Handles performance alerts and notifications
 */
class AlertSystem extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.alertHistory = [];
    this.alertCooldowns = new Map();
  }

  async initialize() {
    if (this.options.verbose) {
      console.log('[AlertSystem] Initialized alerting system');
    }
  }

  handlePerformanceIssues(issues) {
    issues.forEach(issue => {
      this.createAlert('performance', issue.severity, `${issue.type}: ${issue.value.toFixed(2)}`, issue);
    });
  }

  handleMemoryAlert(memoryInfo) {
    this.createAlert('memory', 'warning', 
      `High memory usage: ${(memoryInfo.heapUtilization * 100).toFixed(1)}%`, 
      memoryInfo
    );
  }

  handleMemoryLeakAlert(leakAnalysis) {
    this.createAlert('memory-leak', 'critical',
      `Memory leak suspected: ${(leakAnalysis.growth_rate * 100).toFixed(1)}% growth rate`,
      leakAnalysis
    );
  }

  handleGCAlert(gcAnalysis) {
    this.createAlert('gc', 'warning', 'Garbage collection issues detected', gcAnalysis);
  }

  createAlert(type, severity, message, data) {
    const alertKey = `${type}-${severity}`;
    const cooldownMs = 5 * 60 * 1000; // 5 minutes
    
    // Check cooldown
    const lastAlert = this.alertCooldowns.get(alertKey);
    if (lastAlert && Date.now() - lastAlert < cooldownMs) {
      return; // Skip duplicate alert
    }

    const alert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      severity,
      message,
      data,
      timestamp: Date.now(),
    };

    this.alertHistory.push(alert);
    this.alertCooldowns.set(alertKey, Date.now());
    
    // Trim history
    if (this.alertHistory.length > 100) {
      this.alertHistory.shift();
    }

    this.emit('alert-created', alert);
    
    if (this.options.verbose) {
      console.log(`[AlertSystem] ${severity.toUpperCase()} ${type}: ${message}`);
    }
  }

  getRecentAlerts(limit = 10) {
    return this.alertHistory.slice(-limit);
  }

  destroy() {
    this.alertHistory = [];
    this.alertCooldowns.clear();
    this.removeAllListeners();
  }
}

module.exports = {
  PerformanceMonitor,
  MetricsCollector,
  MemoryManager,
  PerformanceAnalyzer,
  AdaptiveOptimizer,
  AlertSystem,
};
