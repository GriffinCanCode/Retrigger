#!/usr/bin/env node

/**
 * @retrigger/daemon - High-performance file system watcher daemon
 * 
 * This package provides the native Rust daemon that powers the Retrigger
 * file watching system. It works in conjunction with @retrigger/core.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Path to the native daemon binary
const DAEMON_BIN = path.join(__dirname, 'bin', 'retrigger');

class RetriggerDaemon {
  constructor() {
    this.process = null;
    this.isRunning = false;
  }

  /**
   * Start the daemon process
   * @param {Object} options - Configuration options
   */
  async start(options = {}) {
    if (this.isRunning) {
      throw new Error('Daemon is already running');
    }

    const args = ['start'];
    
    if (options.config) args.push('--config', options.config);
    if (options.foreground) args.push('--foreground');
    if (options.debug) args.push('--debug');
    if (options.bind) args.push('--bind', options.bind);
    if (options.port) args.push('--port', options.port.toString());

    this.process = spawn(DAEMON_BIN, args, {
      stdio: options.foreground ? 'inherit' : 'ignore',
      detached: !options.foreground
    });

    this.isRunning = true;

    this.process.on('exit', (code) => {
      this.isRunning = false;
      this.process = null;
    });

    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (this.isRunning) {
          resolve();
        } else {
          reject(new Error('Daemon failed to start'));
        }
      }, 1000);
    });
  }

  /**
   * Stop the daemon process
   */
  async stop() {
    if (!this.isRunning || !this.process) {
      return;
    }

    this.process.kill('SIGTERM');
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      this.process.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /**
   * Get daemon status
   */
  async status() {
    const statusProcess = spawn(DAEMON_BIN, ['status'], { stdio: 'pipe' });
    
    return new Promise((resolve, reject) => {
      let output = '';
      
      statusProcess.stdout.on('data', (data) => {
        output += data.toString();
      });

      statusProcess.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          reject(new Error('Failed to get daemon status'));
        }
      });
    });
  }

  /**
   * Run benchmark
   */
  async benchmark(options = {}) {
    const args = ['benchmark'];
    
    if (options.directory) args.push('--directory', options.directory);
    if (options.files) args.push('--files', options.files.toString());
    if (options.size) args.push('--size', options.size.toString());

    const benchProcess = spawn(DAEMON_BIN, args, { stdio: 'inherit' });
    
    return new Promise((resolve, reject) => {
      benchProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error('Benchmark failed'));
        }
      });
    });
  }

  /**
   * Validate configuration file
   */
  async validateConfig(configPath) {
    const validateProcess = spawn(DAEMON_BIN, ['validate', '--config', configPath], { stdio: 'pipe' });
    
    return new Promise((resolve, reject) => {
      let output = '';
      
      validateProcess.stdout.on('data', (data) => {
        output += data.toString();
      });

      validateProcess.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          reject(new Error('Configuration validation failed'));
        }
      });
    });
  }

  /**
   * Generate default configuration
   */
  async generateConfig(outputPath = 'retrigger.toml') {
    const configProcess = spawn(DAEMON_BIN, ['config', '--output', outputPath], { stdio: 'pipe' });
    
    return new Promise((resolve, reject) => {
      configProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error('Failed to generate configuration'));
        }
      });
    });
  }
}

// Export the class and a default instance
module.exports = RetriggerDaemon;
module.exports.RetriggerDaemon = RetriggerDaemon;
module.exports.daemon = new RetriggerDaemon();

// Binary path for direct access
module.exports.DAEMON_BIN = DAEMON_BIN;
