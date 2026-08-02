//! Tests that run the shipped binary.
//!
//! Everything here goes through `std::process::Command` on the real executable, because the
//! things being checked are contracts with things that are not Rust: the Docker healthcheck runs
//! `retrigger --version`, the npm post-install runs it too, and `bin/retrigger.js` shells out to
//! `start`, `stop`, and `status`. A unit test on the argument parser cannot catch a binary that
//! exits 1 on startup.

use std::fs;
use std::io::ErrorKind;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

const BINARY: &str = env!("CARGO_BIN_EXE_retrigger");
const STARTUP_BUDGET: Duration = Duration::from_secs(20);

/// Kills the daemon when the test ends, however it ends.
struct Running {
    child: std::process::Child,
    log: PathBuf,
}

impl Running {
    fn logs(&self) -> String {
        fs::read_to_string(&self.log).unwrap_or_default()
    }

    /// Wait for the process to exit, killing it if it overruns.
    fn wait(mut self, budget: Duration) -> Result<std::process::ExitStatus> {
        let deadline = Instant::now() + budget;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait()? {
                return Ok(status);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let logs = self.logs();
        bail!("the daemon did not exit within {budget:?}; logs:\n{logs}")
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn run(args: &[&str]) -> Result<Output> {
    Command::new(BINARY)
        .args(args)
        .output()
        .context("could not run the retrigger binary")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// A port nothing is listening on. Inherently racy — the kernel could hand it to someone else
/// between the drop and the bind — but ephemeral ports are not reused that fast in practice, and
/// the alternative is hard-coding a port that collides with a developer's own daemon.
fn free_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn config_file(dir: &Path, port: u16, watched: &Path) -> Result<PathBuf> {
    let path = dir.join("retrigger.toml");
    fs::write(
        &path,
        format!(
            "[server]\nbind_address = \"127.0.0.1\"\nport = {port}\n\n\
             [watcher]\ndebounce_ms = 0\n\n\
             [[watcher.paths]]\npath = {:?}\nrecursive = true\n",
            watched.display()
        ),
    )?;
    Ok(path)
}

fn start_daemon(dir: &Path, config: &Path) -> Result<Running> {
    let log = dir.join("daemon.log");
    let sink = fs::File::create(&log)?;
    let child = Command::new(BINARY)
        .args(["start", "--config"])
        .arg(config)
        .stdout(Stdio::from(sink.try_clone()?))
        .stderr(Stdio::from(sink))
        // `start` with no --config looks for ./retrigger.toml; run from the temp directory so a
        // test can never pick up the repository's own file.
        .current_dir(dir)
        .spawn()
        .context("could not spawn the daemon")?;
    Ok(Running { child, log })
}

fn wait_until_listening(address: SocketAddr, daemon: &Running) -> Result<()> {
    let deadline = Instant::now() + STARTUP_BUDGET;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    bail!(
        "the daemon never listened on {address}; logs:\n{}",
        daemon.logs()
    )
}

#[test]
fn version_prints_a_version_and_exits_zero() -> Result<()> {
    // The Docker healthcheck, the npm CLI shim, and the post-install check all run exactly this.
    let output = run(&["--version"])?;
    assert!(
        output.status.success(),
        "--version must exit 0, got {:?}: {}",
        output.status.code(),
        stderr(&output)
    );

    let printed = stdout(&output);
    assert!(
        printed.contains(env!("CARGO_PKG_VERSION")),
        "--version printed {printed:?}, which does not contain {}",
        env!("CARGO_PKG_VERSION")
    );
    assert!(printed.starts_with("retrigger "), "{printed:?}");
    Ok(())
}

#[test]
fn help_lists_every_subcommand_and_exits_zero() -> Result<()> {
    let output = run(&["--help"])?;
    assert!(output.status.success());
    let printed = stdout(&output);
    for subcommand in ["start", "stop", "status", "validate", "config", "benchmark"] {
        assert!(
            printed.contains(subcommand),
            "`{subcommand}` missing:\n{printed}"
        );
    }
    Ok(())
}

#[test]
fn no_subcommand_is_a_usage_error_not_a_silent_success() -> Result<()> {
    let output = run(&[])?;
    assert!(!output.status.success(), "bare `retrigger` must not exit 0");
    assert!(stderr(&output).contains("Usage"));
    Ok(())
}

#[test]
fn a_generated_config_validates_and_will_not_be_clobbered_by_accident() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("retrigger.toml");
    let path_arg = path.display().to_string();

    let written = run(&["config", "--output", &path_arg])?;
    assert!(written.status.success(), "{}", stderr(&written));
    assert!(path.exists());

    let validated = run(&["validate", "--config", &path_arg])?;
    assert!(
        validated.status.success(),
        "the file `config` generates must pass `validate`: {}",
        stderr(&validated)
    );
    assert!(stdout(&validated).contains("is valid"));

    let clobbered = run(&["config", "--output", &path_arg])?;
    assert!(
        !clobbered.status.success(),
        "overwriting an existing config without --force must fail"
    );
    assert!(stderr(&clobbered).contains("--force"));

    let forced = run(&["config", "--output", &path_arg, "--force"])?;
    assert!(forced.status.success(), "{}", stderr(&forced));

    // `-` is documented as standard output, and must not create a file called `-`.
    let piped = run(&["config", "--output", "-"])?;
    assert!(piped.status.success());
    assert!(stdout(&piped).contains("[watcher]"));
    assert!(!Path::new("-").exists());
    Ok(())
}

#[test]
fn validate_reports_a_missing_or_broken_file_instead_of_pretending() -> Result<()> {
    let dir = tempfile::tempdir()?;

    let missing = dir.path().join("nope.toml");
    let output = run(&["validate", "--config", &missing.display().to_string()])?;
    assert!(!output.status.success(), "a missing file must not validate");
    assert!(
        stderr(&output).contains("nope.toml"),
        "the error must name the file:\n{}",
        stderr(&output)
    );

    let broken = dir.path().join("broken.toml");
    fs::write(&broken, "[server]\nport = \"nine thousand\"\n")?;
    let output = run(&["validate", "--config", &broken.display().to_string()])?;
    assert!(!output.status.success());

    let fictional = dir.path().join("fictional.toml");
    fs::write(&fictional, "[performance]\nenable_simd = true\n")?;
    let output = run(&["validate", "--config", &fictional.display().to_string()])?;
    assert!(
        !output.status.success(),
        "a key the daemon does not read must be reported, not ignored"
    );
    assert!(
        stderr(&output).contains("unknown field"),
        "{}",
        stderr(&output)
    );

    // A path that does not exist is a warning, not a failure: a config can be validated on a
    // machine that is not the one it will run on.
    let elsewhere = dir.path().join("elsewhere.toml");
    fs::write(
        &elsewhere,
        "[[watcher.paths]]\npath = \"/definitely/not/here\"\n",
    )?;
    let output = run(&["validate", "--config", &elsewhere.display().to_string()])?;
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stderr(&output).contains("does not exist"));
    Ok(())
}

#[test]
fn talking_to_a_daemon_that_is_not_there_says_so() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let port = free_port()?.to_string();
    let config = config_file(dir.path(), 0, dir.path())?;
    let config = config.display().to_string();

    let status = run(&["status", "--config", &config, "--port", &port])?;
    assert!(
        !status.status.success(),
        "status must fail when nothing answers"
    );
    assert!(
        stderr(&status).contains("no daemon"),
        "the message must be actionable:\n{}",
        stderr(&status)
    );

    // `stop`, though, is idempotent: scripts call it to reach a state.
    let stop = run(&["stop", "--config", &config, "--port", &port])?;
    assert!(
        stop.status.success(),
        "stopping something already stopped must succeed: {}",
        stderr(&stop)
    );
    assert!(stdout(&stop).contains("no daemon"));
    Ok(())
}

#[test]
fn a_port_that_is_already_taken_fails_fast_with_a_clear_message() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let squatter = TcpListener::bind("127.0.0.1:0")?;
    let port = squatter.local_addr()?.port();
    let config = config_file(dir.path(), port, dir.path())?;

    let daemon = start_daemon(dir.path(), &config)?;
    let status = daemon.wait(Duration::from_secs(15))?;
    assert!(
        !status.success(),
        "starting on a taken port must not report success"
    );
    Ok(())
}

#[test]
fn the_full_lifecycle_works_from_the_command_line() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let watched = dir.path().join("tree");
    fs::create_dir(&watched)?;
    let port = free_port()?;
    let config = config_file(dir.path(), port, &watched)?;
    let config_arg = config.display().to_string();
    let port_arg = port.to_string();
    let address: SocketAddr = format!("127.0.0.1:{port}").parse()?;

    let daemon = start_daemon(dir.path(), &config)?;
    wait_until_listening(address, &daemon)?;

    let status = run(&["status", "--config", &config_arg])?;
    assert!(status.status.success(), "{}", stderr(&status));
    let printed = stdout(&status);
    assert!(printed.starts_with("retrigger "), "{printed}");
    assert!(printed.contains("watching    yes"), "{printed}");
    assert!(
        printed.contains(&watched.display().to_string()),
        "the configured path should be listed:\n{printed}"
    );

    // The machine-readable form is the same data, and it must parse.
    let json = run(&["status", "--config", &config_arg, "--json"])?;
    assert!(json.status.success(), "{}", stderr(&json));
    let parsed: serde_json::Value = serde_json::from_str(stdout(&json).trim())?;
    assert_eq!(parsed["running"], true);
    assert_eq!(parsed["address"], address.to_string());

    // And the daemon is actually hashing: write a file, then watch the counters move.
    fs::write(watched.join("hello.txt"), b"hello")?;
    let deadline = Instant::now() + STARTUP_BUDGET;
    let mut hashed = 0;
    while Instant::now() < deadline && hashed == 0 {
        let json = run(&["status", "--config", &config_arg, "--json"])?;
        let parsed: serde_json::Value = serde_json::from_str(stdout(&json).trim())?;
        hashed = parsed["processor"]["files_hashed"].as_u64().unwrap_or(0);
        if hashed == 0 {
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    assert!(
        hashed > 0,
        "a write under a watched tree should have been hashed; logs:\n{}",
        daemon.logs()
    );

    let stop = run(&["stop", "--config", &config_arg, "--port", &port_arg])?;
    assert!(stop.status.success(), "{}", stderr(&stop));
    assert!(stdout(&stop).contains("stopped"), "{}", stdout(&stop));

    let exit = daemon.wait(Duration::from_secs(15))?;
    assert!(
        exit.success(),
        "a daemon asked to stop must exit 0, got {exit:?}"
    );
    assert!(
        matches!(
            TcpStream::connect_timeout(&address, Duration::from_millis(500)),
            Err(err) if err.kind() == ErrorKind::ConnectionRefused
        ),
        "the port must be free once the daemon has exited"
    );
    Ok(())
}

#[test]
fn benchmark_runs_end_to_end_and_cleans_up_after_itself() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let before: Vec<_> = fs::read_dir(dir.path())?.collect();
    assert!(before.is_empty());

    let output = run(&[
        "benchmark",
        "--directory",
        &dir.path().display().to_string(),
        "--files",
        "32",
        "--size",
        "256",
    ])?;
    assert!(output.status.success(), "{}", stderr(&output));

    let printed = stdout(&output);
    assert!(printed.contains("throughput"), "{printed}");
    assert!(printed.contains("delivered"), "{printed}");
    assert_eq!(
        fs::read_dir(dir.path())?.count(),
        0,
        "the scratch tree must be removed, even though the benchmark wrote 32 files into it"
    );
    Ok(())
}
