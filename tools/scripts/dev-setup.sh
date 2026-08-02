#!/bin/bash
# Retrigger Development Environment Setup Script

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Detect OS
detect_os() {
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo "linux"
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        echo "macos"
    elif [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "msys" ]]; then
        echo "windows"
    else
        echo "unknown"
    fi
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Install Rust
install_rust() {
    if command_exists rustc; then
        log_info "Rust already installed: $(rustc --version)"
        return 0
    fi
    
    log_info "Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    
    # Source cargo env
    source ~/.cargo/env || export PATH="$HOME/.cargo/bin:$PATH"
    
    # Install components
    rustup component add rustfmt clippy
    
    # Install useful tools
    cargo install cargo-watch cargo-nextest
    
    log_success "Rust installed successfully"
}

# Install Node.js
install_node() {
    if command_exists node; then
        log_info "Node.js already installed: $(node --version)"
        return 0
    fi
    
    log_info "Installing Node.js..."
    
    local os=$(detect_os)
    
    case "$os" in
        "linux")
            # Install via NodeSource repository
            curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
            sudo apt-get install -y nodejs
            ;;
        "macos")
            if command_exists brew; then
                brew install node
            else
                log_error "Homebrew not found. Please install Node.js manually from https://nodejs.org"
                return 1
            fi
            ;;
        *)
            log_error "Unsupported OS for Node.js installation: $os"
            return 1
            ;;
    esac
    
    log_success "Node.js installed successfully"
}

# Install system dependencies
install_system_deps() {
    log_info "Installing system dependencies..."
    
    local os=$(detect_os)
    
    case "$os" in
        "linux")
            # Update package lists
            sudo apt-get update
            
            # Install build essentials and dependencies
            sudo apt-get install -y \
                build-essential \
                clang \
                llvm-dev \
                pkg-config \
                liburing-dev \
                git \
                curl \
                wget \
                ca-certificates
            ;;
        "macos")
            if command_exists brew; then
                # Install dependencies via Homebrew
                brew install llvm pkg-config git curl wget
                
                # Note: liburing is Linux-specific, not needed on macOS
                log_info "macOS detected - skipping liburing (Linux-specific)"
            else
                log_warning "Homebrew not found. Please install manually:"
                log_warning "  - Xcode Command Line Tools: xcode-select --install"
                log_warning "  - Homebrew: https://brew.sh"
            fi
            ;;
        *)
            log_error "Unsupported OS for system dependencies: $os"
            return 1
            ;;
    esac
    
    log_success "System dependencies installed"
}

# Setup pre-commit hooks
setup_git_hooks() {
    log_info "Setting up Git hooks..."
    
    local hooks_dir=".git/hooks"
    
    if [[ ! -d ".git" ]]; then
        log_warning "Not in a Git repository, skipping Git hooks"
        return 0
    fi
    
    # Pre-commit hook
    cat > "$hooks_dir/pre-commit" << 'EOF'
#!/bin/bash
# Retrigger pre-commit hook

set -e

echo "Running pre-commit checks..."

# Format Rust code
echo "Formatting Rust code..."
cargo fmt --check || {
    echo "Code formatting required. Run: cargo fmt"
    exit 1
}

# Lint Rust code
echo "Linting Rust code..."
cargo clippy --all-targets -- -D warnings

# Format C code
if command -v clang-format >/dev/null 2>&1; then
    echo "Checking C code formatting..."
    find src/core \( -name "*.c" -o -name "*.h" \) -print0 | xargs -0 clang-format --dry-run --Werror
fi

echo "Pre-commit checks passed!"
EOF

    chmod +x "$hooks_dir/pre-commit"
    
    log_success "Git hooks installed"
}

# Create development configuration
create_dev_config() {
    log_info "Creating development configuration..."
    
    # Unknown keys are rejected by the daemon, so this must track the schema in
    # retrigger-daemon/src/config.rs. `retrigger validate -c retrigger-dev.toml`
    # is the check; the block below is verified by the call right after it.
    cat > "retrigger-dev.toml" << 'EOF'
# Retrigger development configuration, written by tools/scripts/dev-setup.sh.

[server]
bind_address = "127.0.0.1"
port = 9090

[watcher]
queue_capacity = 8192
debounce_ms = 50
follow_symlinks = true
hash_cache_size = 10000
hash_cache_ttl_secs = 600

[[watcher.paths]]
path = "."
recursive = true

[patterns]
include = []
exclude = [
    "**/target/**",
    "**/node_modules/**",
    "**/.git/**",
    "**/build/**",
    "**/*.log",
]

[logging]
level = "debug"
format = "pretty"
EOF

    # Fail loudly if the generated file drifts from the daemon's schema, rather
    # than handing a new contributor a config that only breaks at `start`.
    if command_exists retrigger; then
        retrigger validate -c retrigger-dev.toml >/dev/null 2>&1 \
            || log_warning "retrigger-dev.toml was rejected by \`retrigger validate\`; the generator in this script has drifted from the daemon's schema."
    fi

    log_success "Development configuration created: retrigger-dev.toml"
}

# Setup VS Code configuration
setup_vscode() {
    if [[ ! -d ".vscode" ]]; then
        mkdir -p .vscode
    fi
    
    log_info "Setting up VS Code configuration..."
    
    # Settings
    cat > ".vscode/settings.json" << 'EOF'
{
    "rust-analyzer.checkOnSave.command": "clippy",
    "rust-analyzer.cargo.features": "all",
    "C_Cpp.default.includePath": [
        "${workspaceFolder}/src/core/include"
    ],
    "editor.formatOnSave": true,
    "editor.rulers": [100],
    "files.exclude": {
        "**/target": true,
        "**/build": true,
        "**/.git": true,
        "**/*.log": true
    }
}
EOF

    # Extensions recommendations
    cat > ".vscode/extensions.json" << 'EOF'
{
    "recommendations": [
        "rust-lang.rust-analyzer",
        "ms-vscode.cpptools",
        "vadimcn.vscode-lldb",
        "serayuzgur.crates",
        "tamasfe.even-better-toml"
    ]
}
EOF

    # Tasks
    cat > ".vscode/tasks.json" << 'EOF'
{
    "version": "2.0.0",
    "tasks": [
        {
            "label": "build-all",
            "type": "shell",
            "command": "make",
            "args": ["all"],
            "group": {
                "kind": "build",
                "isDefault": true
            },
            "presentation": {
                "echo": true,
                "reveal": "always",
                "focus": false,
                "panel": "shared"
            }
        },
        {
            "label": "test-all",
            "type": "shell",
            "command": "make",
            "args": ["test"],
            "group": "test",
            "presentation": {
                "echo": true,
                "reveal": "always",
                "focus": false,
                "panel": "shared"
            }
        },
        {
            "label": "clean",
            "type": "shell",
            "command": "make",
            "args": ["clean"],
            "group": "build"
        }
    ]
}
EOF

    log_success "VS Code configuration created"
}

# Main setup function
main() {
    log_info "Starting Retrigger development environment setup..."
    log_info "Detected OS: $(detect_os)"
    
    # Check if we're in the right directory
    if [[ ! -f "Cargo.toml" ]] || [[ ! -d "core" ]]; then
        log_error "Please run this script from the Retrigger project root directory"
        exit 1
    fi
    
    # Install dependencies
    install_system_deps
    install_rust
    install_node
    
    # Setup project
    setup_git_hooks
    create_dev_config
    setup_vscode
    
    # Build the project
    log_info "Building project..."
    make dev
    
    log_success "Development environment setup complete!"
    log_info ""
    log_info "Next steps:"
    log_info "  1. Open the project in VS Code"
    log_info "  2. Install recommended extensions"
    log_info "  3. Run 'make dev' to start development mode"
    log_info "  4. Run 'make test' to verify everything works"
    log_info ""
    log_info "Development configuration: retrigger-dev.toml"
    log_info "Run daemon: ./target/debug/retrigger start --config retrigger-dev.toml --foreground --debug"
}

# Run main function
main "$@"
