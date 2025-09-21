//! Configuration management with hot-reload support
//! Follows SRP: Only handles configuration loading and validation

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, RwLock};
use tracing::{debug, info, warn};

/// Main daemon configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonConfig {
    pub server: ServerConfig,
    pub watcher: WatcherConfig,
    pub performance: PerformanceConfig,
    pub logging: LoggingConfig,
    pub patterns: PatternConfig,
}

/// Server configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    /// gRPC server bind address
    pub bind_address: String,
    /// gRPC server port
    pub port: u16,
    /// Maximum concurrent connections
    pub max_connections: usize,
    /// Request timeout in milliseconds
    pub request_timeout_ms: u64,
    /// Enable Prometheus metrics endpoint
    pub enable_metrics: bool,
    /// Metrics port
    pub metrics_port: u16,
}

/// File watcher configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatcherConfig {
    /// Directories to watch on startup
    pub watch_paths: Vec<WatchPath>,
    /// Event buffer size (number of events)
    pub event_buffer_size: usize,
    /// Hash cache size (number of files)
    pub hash_cache_size: usize,
    /// Hash cache TTL in seconds
    pub hash_cache_ttl_secs: u64,
    /// Block size for incremental hashing
    pub hash_block_size: u32,
}

/// Watch path configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchPath {
    pub path: PathBuf,
    pub recursive: bool,
    pub enabled: bool,
}

/// Performance tuning configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceConfig {
    /// Worker thread count (0 = auto)
    pub worker_threads: usize,
    /// Enable SIMD optimizations
    pub enable_simd: bool,
    /// Batch size for event processing
    pub event_batch_size: usize,
    /// Polling interval in microseconds
    pub poll_interval_us: u64,
    /// Enable zero-copy optimizations
    pub enable_zero_copy: bool,
}

/// Logging configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggingConfig {
    /// Log level (error, warn, info, debug, trace)
    pub level: String,
    /// Log format (json, pretty, compact)
    pub format: String,
    /// Log to file
    pub file: Option<PathBuf>,
    /// Enable structured logging
    pub structured: bool,
}

/// File pattern configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatternConfig {
    /// Patterns to include (glob format)
    pub include: Vec<String>,
    /// Patterns to exclude (glob format)  
    pub exclude: Vec<String>,
    /// File size limits
    pub max_file_size: u64,
    /// Binary file detection
    pub ignore_binary: bool,
}

impl Default for DaemonConfig {
    fn default() -> Self {
        Self {
            server: ServerConfig::default(),
            watcher: WatcherConfig::default(),
            performance: PerformanceConfig::default(),
            logging: LoggingConfig::default(),
            patterns: PatternConfig::default(),
        }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind_address: "127.0.0.1".to_string(),
            port: 9090,
            max_connections: 1000,
            request_timeout_ms: 30000,
            enable_metrics: true,
            metrics_port: 9091,
        }
    }
}

impl Default for WatcherConfig {
    fn default() -> Self {
        Self {
            watch_paths: vec![],
            event_buffer_size: 65536,
            hash_cache_size: 100000,
            hash_cache_ttl_secs: 3600,
            hash_block_size: 4096,
        }
    }
}

impl Default for PerformanceConfig {
    fn default() -> Self {
        Self {
            worker_threads: 0, // auto-detect
            enable_simd: true,
            event_batch_size: 100,
            poll_interval_us: 1000,
            enable_zero_copy: true,
        }
    }
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            level: "info".to_string(),
            format: "pretty".to_string(),
            file: None,
            structured: false,
        }
    }
}

impl Default for PatternConfig {
    fn default() -> Self {
        Self {
            include: vec!["**/*".to_string()],
            exclude: vec![
                "**/node_modules/**".to_string(),
                "**/.git/**".to_string(),
                "**/target/**".to_string(),
                "**/*.log".to_string(),
                "**/.*".to_string(),
            ],
            max_file_size: 100 * 1024 * 1024, // 100MB
            ignore_binary: true,
        }
    }
}

/// Compiled pattern matcher for performance
#[derive(Debug, Clone)]
pub struct CompiledPatterns {
    include: GlobSet,
    exclude: GlobSet,
}

impl CompiledPatterns {
    pub fn new(config: &PatternConfig) -> Result<Self> {
        let mut include_builder = GlobSetBuilder::new();
        for pattern in &config.include {
            let glob = Glob::new(pattern)
                .with_context(|| format!("Invalid include pattern: {}", pattern))?;
            include_builder.add(glob);
        }

        let mut exclude_builder = GlobSetBuilder::new();
        for pattern in &config.exclude {
            let glob = Glob::new(pattern)
                .with_context(|| format!("Invalid exclude pattern: {}", pattern))?;
            exclude_builder.add(glob);
        }

        Ok(Self {
            include: include_builder.build()?,
            exclude: exclude_builder.build()?,
        })
    }

    /// Check if a file should be watched based on patterns
    pub fn should_watch(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy();

        // Check include patterns first
        if !self.include.is_match(&*path_str) {
            return false;
        }

        // Check exclude patterns
        !self.exclude.is_match(&*path_str)
    }
}

/// Configuration manager with hot-reload capability
pub struct ConfigManager {
    config: Arc<RwLock<DaemonConfig>>,
    patterns: Arc<RwLock<CompiledPatterns>>,
    config_path: Option<PathBuf>,
    change_sender: broadcast::Sender<DaemonConfig>,
}

impl ConfigManager {
    /// Create a new configuration manager
    pub fn new() -> Self {
        let config = DaemonConfig::default();
        let patterns =
            CompiledPatterns::new(&config.patterns).expect("Default patterns should be valid");

        let (change_sender, _) = broadcast::channel(10);

        Self {
            config: Arc::new(RwLock::new(config)),
            patterns: Arc::new(RwLock::new(patterns)),
            config_path: None,
            change_sender,
        }
    }

    /// Load configuration from file
    pub async fn load_from_file<P: AsRef<Path>>(&mut self, path: P) -> Result<()> {
        let path = path.as_ref();
        let config_str = tokio::fs::read_to_string(path)
            .await
            .with_context(|| format!("Failed to read config file: {}", path.display()))?;

        let new_config: DaemonConfig =
            toml::from_str(&config_str).with_context(|| "Failed to parse config file")?;

        // Compile patterns
        let patterns = CompiledPatterns::new(&new_config.patterns)?;

        // Update config
        {
            let mut config_guard = self.config.write().await;
            *config_guard = new_config.clone();
        }

        {
            let mut patterns_guard = self.patterns.write().await;
            *patterns_guard = patterns;
        }

        self.config_path = Some(path.to_path_buf());

        // Notify subscribers of config change
        if let Err(e) = self.change_sender.send(new_config) {
            debug!("No config change subscribers: {}", e);
        }

        info!("Loaded configuration from: {}", path.display());
        Ok(())
    }

    /// Save current configuration to file
    pub async fn save_to_file<P: AsRef<Path>>(&self, path: P) -> Result<()> {
        let config = self.config.read().await;
        let config_str = toml::to_string_pretty(&*config)?;

        tokio::fs::write(path.as_ref(), config_str)
            .await
            .with_context(|| format!("Failed to write config file: {}", path.as_ref().display()))?;

        info!("Saved configuration to: {}", path.as_ref().display());
        Ok(())
    }

    /// Get current configuration
    pub async fn get_config(&self) -> DaemonConfig {
        self.config.read().await.clone()
    }

    /// Get compiled patterns
    pub async fn get_patterns(&self) -> CompiledPatterns {
        self.patterns.read().await.clone()
    }

    /// Subscribe to configuration changes
    pub fn subscribe_changes(&self) -> broadcast::Receiver<DaemonConfig> {
        self.change_sender.subscribe()
    }

    /// Start hot-reload monitoring
    pub async fn start_hot_reload(&self) -> Result<()> {
        let config_path = self
            .config_path
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No config file loaded"))?;

        let config_path = config_path.clone();
        let config = Arc::clone(&self.config);
        let patterns = Arc::clone(&self.patterns);
        let change_sender = self.change_sender.clone();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            let mut last_modified = None;

            loop {
                interval.tick().await;

                // Check file modification time
                match tokio::fs::metadata(&config_path).await {
                    Ok(metadata) => {
                        let modified = metadata.modified().ok();

                        if last_modified.is_none() {
                            last_modified = modified;
                            continue;
                        }

                        if modified != last_modified {
                            last_modified = modified;

                            // Reload config
                            match Self::reload_config(&config_path, &config, &patterns).await {
                                Ok(new_config) => {
                                    info!("Hot-reloaded configuration");
                                    let _ = change_sender.send(new_config);
                                }
                                Err(e) => {
                                    warn!("Failed to hot-reload config: {}", e);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        warn!("Failed to check config file: {}", e);
                    }
                }
            }
        });

        info!("Started configuration hot-reload monitoring");
        Ok(())
    }

    /// Internal method to reload configuration
    async fn reload_config(
        path: &Path,
        config: &Arc<RwLock<DaemonConfig>>,
        patterns: &Arc<RwLock<CompiledPatterns>>,
    ) -> Result<DaemonConfig> {
        let config_str = tokio::fs::read_to_string(path).await?;
        let new_config: DaemonConfig = toml::from_str(&config_str)?;
        let new_patterns = CompiledPatterns::new(&new_config.patterns)?;

        // Update config atomically
        {
            let mut config_guard = config.write().await;
            *config_guard = new_config.clone();
        }

        {
            let mut patterns_guard = patterns.write().await;
            *patterns_guard = new_patterns;
        }

        Ok(new_config)
    }

    /// Validate configuration
    pub fn validate(config: &DaemonConfig) -> Result<()> {
        // Validate server config
        if config.server.port == 0 {
            anyhow::bail!("Invalid server port: {}", config.server.port);
        }

        if config.server.max_connections == 0 {
            anyhow::bail!("max_connections must be > 0");
        }

        // Validate watcher config
        if config.watcher.event_buffer_size == 0 {
            anyhow::bail!("event_buffer_size must be > 0");
        }

        // Validate patterns
        for pattern in &config.patterns.include {
            Glob::new(pattern).with_context(|| format!("Invalid include pattern: {}", pattern))?;
        }

        for pattern in &config.patterns.exclude {
            Glob::new(pattern).with_context(|| format!("Invalid exclude pattern: {}", pattern))?;
        }

        Ok(())
    }
}

impl Default for ConfigManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;
    use std::io::Write;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn test_config_load_save() {
        let mut temp_file = NamedTempFile::new().unwrap();

        // Write test config
        let config_toml = r#"
[server]
bind_address = "0.0.0.0"
port = 8080

[watcher]
event_buffer_size = 32768

[patterns]
include = ["**/*.rs", "**/*.toml"]
exclude = ["**/target/**"]
"#;

        temp_file.write_all(config_toml.as_bytes()).unwrap();
        temp_file.flush().unwrap();

        // Load config
        let mut manager = ConfigManager::new();
        manager.load_from_file(temp_file.path()).await.unwrap();

        let config = manager.get_config().await;
        assert_eq!(config.server.bind_address, "0.0.0.0");
        assert_eq!(config.server.port, 8080);
        assert_eq!(config.watcher.event_buffer_size, 32768);
    }

    #[tokio::test]
    async fn test_pattern_matching() {
        let config = PatternConfig {
            include: vec!["**/*.rs".to_string()],
            exclude: vec!["**/target/**".to_string()],
            ..Default::default()
        };

        let patterns = CompiledPatterns::new(&config).unwrap();

        assert!(patterns.should_watch(Path::new("src/main.rs")));
        assert!(!patterns.should_watch(Path::new("target/debug/main.rs")));
        assert!(!patterns.should_watch(Path::new("README.md")));
    }
}
