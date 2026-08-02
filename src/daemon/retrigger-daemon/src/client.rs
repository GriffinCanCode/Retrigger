//! The small HTTP client `status` and `stop` use to talk to a running daemon.
//!
//! A full HTTP client crate would be the largest dependency in this binary, to issue two
//! requests to a server on the same machine. Instead the requests go out as **HTTP/1.0**, which
//! forbids chunked transfer-encoding and closes the connection when the body ends — so "read
//! until EOF" is the whole framing story and there is no parser to get wrong.
//!
//! This is not a general-purpose client. It does not do redirects, keep-alive, TLS, or request
//! bodies, and it never will: the moment something here needs those, it should be talking to a
//! real client library instead.

use std::io;
use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Ceiling on a response body. `/status` is a few kilobytes; anything approaching this is a bug
/// or a stranger on the port, and neither deserves unbounded memory.
const MAX_RESPONSE_BYTES: u64 = 1 << 20;

/// A response from the daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    /// HTTP status code.
    pub status: u16,
    /// Response body, as text.
    pub body: String,
}

impl HttpResponse {
    /// Whether the status is in the 2xx range.
    #[must_use]
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// What came back from an address that may not have a daemon on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    /// A daemon answered.
    Answered(HttpResponse),
    /// Nothing is listening there. Carries the reason, which is worth printing: "connection
    /// refused" and "no route to host" send the reader to very different places.
    Unreachable(String),
}

/// `GET path`, tolerating the absence of a daemon.
///
/// # Errors
///
/// If a connection was established but the exchange failed — a truncated response, a reply that
/// is not HTTP, or a timeout mid-transfer.
pub async fn get(address: SocketAddr, path: &str, timeout: Duration) -> Result<Reply> {
    request(address, "GET", path, timeout).await
}

/// `POST path` with an empty body, tolerating the absence of a daemon.
///
/// # Errors
///
/// As [`get`].
pub async fn post(address: SocketAddr, path: &str, timeout: Duration) -> Result<Reply> {
    request(address, "POST", path, timeout).await
}

/// Whether anything accepts a connection on `address`.
///
/// Inherently a snapshot: the answer can be stale by the time it is read. Used only to report
/// that a daemon has finished shutting down.
pub async fn is_listening(address: SocketAddr, timeout: Duration) -> bool {
    matches!(
        tokio::time::timeout(timeout, TcpStream::connect(address)).await,
        Ok(Ok(_))
    )
}

async fn request(
    address: SocketAddr,
    method: &str,
    path: &str,
    timeout: Duration,
) -> Result<Reply> {
    let stream = match tokio::time::timeout(timeout, TcpStream::connect(address)).await {
        Ok(Ok(stream)) => stream,
        Ok(Err(err)) if is_absence(&err) => return Ok(Reply::Unreachable(err.to_string())),
        Ok(Err(err)) => return Err(err).with_context(|| format!("could not connect to {address}")),
        Err(_) => {
            return Ok(Reply::Unreachable(format!(
                "no answer within {}ms",
                timeout.as_millis()
            )))
        }
    };

    let exchange = exchange(stream, method, path, address);
    let raw = tokio::time::timeout(timeout, exchange)
        .await
        .with_context(|| format!("{method} {path} timed out after {}ms", timeout.as_millis()))?
        .with_context(|| format!("{method} {path} failed"))?;

    parse(&raw).map(Reply::Answered)
}

async fn exchange(
    mut stream: TcpStream,
    method: &str,
    path: &str,
    host: SocketAddr,
) -> io::Result<Vec<u8>> {
    let request = format!(
        "{method} {path} HTTP/1.0\r\n\
         Host: {host}\r\n\
         Accept: application/json\r\n\
         Content-Length: 0\r\n\
         Connection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await?;
    stream.flush().await?;

    let mut raw = Vec::new();
    stream
        .take(MAX_RESPONSE_BYTES)
        .read_to_end(&mut raw)
        .await?;
    Ok(raw)
}

/// Whether an error means "nothing is there", as opposed to "something went wrong".
fn is_absence(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::AddrNotAvailable
            | io::ErrorKind::TimedOut
    )
}

fn parse(raw: &[u8]) -> Result<HttpResponse> {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .context("the response ended before its headers did")?;

    let head = std::str::from_utf8(&raw[..split]).context("the response headers are not UTF-8")?;
    let status_line = head.lines().next().unwrap_or_default();
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .with_context(|| format!("not an HTTP response; first line was {status_line:?}"))?;

    Ok(HttpResponse {
        status,
        // Lossy on purpose: a diagnostic printed to a terminal is more useful than an error
        // about the encoding of an error.
        body: String::from_utf8_lossy(&raw[split + 4..]).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_normal_response() -> Result<()> {
        let raw = b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}";
        let response = parse(raw)?;
        assert_eq!(response.status, 200);
        assert_eq!(response.body, "{\"ok\":true}");
        assert!(response.is_success());
        Ok(())
    }

    #[test]
    fn parses_an_empty_body() -> Result<()> {
        let response = parse(b"HTTP/1.0 204 No Content\r\n\r\n")?;
        assert_eq!(response.status, 204);
        assert!(response.body.is_empty());
        Ok(())
    }

    #[test]
    fn a_body_containing_the_header_terminator_is_not_truncated() -> Result<()> {
        let raw = b"HTTP/1.0 200 OK\r\n\r\nfirst\r\n\r\nsecond";
        let response = parse(raw)?;
        assert_eq!(
            response.body, "first\r\n\r\nsecond",
            "only the *first* blank line ends the headers"
        );
        Ok(())
    }

    #[test]
    fn error_statuses_are_reported_not_swallowed() -> Result<()> {
        let response = parse(b"HTTP/1.0 404 Not Found\r\n\r\n{\"error\":\"nope\"}")?;
        assert_eq!(response.status, 404);
        assert!(!response.is_success());
        assert!(response.body.contains("nope"));
        Ok(())
    }

    #[test]
    fn a_truncated_or_non_http_reply_is_an_error_not_a_panic() {
        for raw in [
            &b""[..],
            b"HTTP/1.0 200 OK\r\n",
            b"HTTP/1.0 200 OK",
            b"garbage",
            b"\r\n\r\n",
            b"HTTP/1.0 nope OK\r\n\r\nbody",
            b"\x00\x01\x02\r\n\r\n",
        ] {
            assert!(
                parse(raw).is_err(),
                "should have been rejected: {:?}",
                String::from_utf8_lossy(raw)
            );
        }
    }

    #[test]
    fn a_body_that_is_not_utf8_still_yields_a_status() -> Result<()> {
        let mut raw = b"HTTP/1.0 200 OK\r\n\r\n".to_vec();
        raw.extend_from_slice(&[0xff, 0xfe, 0xfd]);
        let response = parse(&raw)?;
        assert_eq!(response.status, 200);
        assert_eq!(response.body.chars().count(), 3, "replacement characters");
        Ok(())
    }

    #[tokio::test]
    async fn a_closed_port_is_reported_as_unreachable_rather_than_an_error() -> Result<()> {
        // Bind, learn the port, then drop the listener so nothing is there any more.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        drop(listener);

        let reply = get(address, "/status", Duration::from_secs(2)).await?;
        assert!(
            matches!(reply, Reply::Unreachable(_)),
            "a closed port means no daemon, not a failure: {reply:?}"
        );
        assert!(!is_listening(address, Duration::from_millis(500)).await);
        Ok(())
    }

    #[tokio::test]
    async fn a_server_that_answers_with_junk_is_an_error() -> Result<()> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let _ = socket.write_all(b"this is not http").await;
            }
        });

        assert!(
            get(address, "/status", Duration::from_secs(2))
                .await
                .is_err(),
            "a reply that is not HTTP must surface as an error, not as a daemon that is absent"
        );
        Ok(())
    }
}
