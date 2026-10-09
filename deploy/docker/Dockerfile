# Multi-stage Dockerfile for Retrigger (glibc / Debian-family runtime).
#
# Two languages, not four: the C hash engine is compiled by retrigger-core's
# build script and linked into the Rust binary, so the runtime image needs the
# single `retrigger` executable and nothing else -- no shared objects, no
# ldconfig, no Zig toolchain, and no liburing (nothing links against it since
# the watcher moved to inotify via `notify`).
#
# Build from the repository root so the context contains src/:
#   docker build -f deploy/docker/Dockerfile -t retrigger .

FROM ubuntu:26.04 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        clang \
        pkg-config \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /build
COPY . .

ENV CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse

# Builds for whichever architecture the image is being built for, so the same
# file works under `docker buildx --platform linux/amd64,linux/arm64`.
RUN cargo build --release --bin retrigger \
    && ./target/release/retrigger --version

FROM ubuntu:26.04 AS runtime
LABEL maintainer="Retrigger Team"
LABEL description="Ultra-fast file system watcher with native performance"

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r retrigger \
    && useradd -r -g retrigger -s /bin/false retrigger

COPY --from=builder /build/target/release/retrigger /usr/local/bin/retrigger

RUN mkdir -p /etc/retrigger /var/lib/retrigger /var/log/retrigger \
    && chown -R retrigger:retrigger /var/lib/retrigger /var/log/retrigger

COPY deploy/docker/retrigger.toml /etc/retrigger/retrigger.toml

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD retrigger --version || exit 1

# One port: the 2.0 daemon serves the control API, the SSE change stream and
# /metrics from the same listener. 9091 was the old separate metrics port.
EXPOSE 9090

USER retrigger

CMD ["retrigger", "start", "--config", "/etc/retrigger/retrigger.toml", "--foreground"]
