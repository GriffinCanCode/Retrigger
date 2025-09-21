# Multi-stage Dockerfile for Retrigger
# Builds C, Zig, Rust, and Node.js components in optimized layers

# Stage 1: Build environment setup
FROM ubuntu:22.04 as builder
LABEL stage=builder

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    clang \
    llvm-dev \
    pkg-config \
    curl \
    wget \
    git \
    ca-certificates \
    liburing-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"
RUN rustup component add rustfmt clippy

# Install Zig
RUN wget -O zig.tar.xz https://ziglang.org/download/0.11.0/zig-linux-x86_64-0.11.0.tar.xz \
    && tar -xf zig.tar.xz \
    && mv zig-linux-x86_64-0.11.0 /opt/zig \
    && ln -s /opt/zig/zig /usr/local/bin/zig \
    && rm zig.tar.xz

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs

# Stage 2: Build Retrigger components
FROM builder as build-stage
WORKDIR /build

# Copy source code
COPY . .

# Set build environment
ENV BUILD_TYPE=release
ENV CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse

# Build all components
RUN make clean && make all

# Run tests during build
RUN make test

# Stage 3: Runtime environment
FROM ubuntu:22.04 as runtime
LABEL maintainer="Retrigger Team"
LABEL description="Ultra-fast file system watcher with native performance"

# Install minimal runtime dependencies
RUN apt-get update && apt-get install -y \
    liburing2 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r retrigger \
    && useradd -r -g retrigger -s /bin/false retrigger

# Copy built binaries and libraries
COPY --from=build-stage /build/target/release/retrigger /usr/local/bin/retrigger
COPY --from=build-stage /build/build/*/lib/libretrigger_hash.so /usr/local/lib/
COPY --from=build-stage /build/system/zig/zig-out/lib/libretrigger_system.so /usr/local/lib/

# Update library cache
RUN ldconfig

# Create directories for runtime
RUN mkdir -p /etc/retrigger /var/lib/retrigger /var/log/retrigger \
    && chown -R retrigger:retrigger /var/lib/retrigger /var/log/retrigger

# Copy default configuration
COPY docker/retrigger.toml /etc/retrigger/retrigger.toml

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD retrigger --version || exit 1

# Expose ports
EXPOSE 9090 9091

# Switch to non-root user
USER retrigger

# Default command
CMD ["retrigger", "start", "--config", "/etc/retrigger/retrigger.toml", "--foreground"]
