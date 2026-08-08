<#
.SYNOPSIS
    Developer entry point for Comet on Windows.

.DESCRIPTION
    scripts/dev.ps1 run       # build and run the real Codex engine + headed app
    scripts/dev.ps1 watch     # rebuild and restart on source changes
    scripts/dev.ps1 demo      # run the seeded visual demo
    scripts/dev.ps1 check     # compile the workspace
    scripts/dev.ps1 test      # run workspace tests
    scripts/dev.ps1 fmt       # format the workspace
    scripts/dev.ps1 lint      # run clippy
#>

param(
    [string]$Command = "run",
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"

# Get absolute path of workspace root
$ROOT = Resolve-Path (Join-Path $PSScriptRoot "..")
$PORT = if ($env:COMET_DEV_IPC_PORT) { $env:COMET_DEV_IPC_PORT } else { "27922" }
$TOKEN = if ($env:COMET_EDGE_TOKEN) { $env:COMET_EDGE_TOKEN } else { "dev@dev-org" }
$HARNESS = if ($env:COMET_HARNESS) { $env:COMET_HARNESS } else { "codex" }
$DAEMON_DIR = if ($env:COMET_DEV_DATA_DIR) { $env:COMET_DEV_DATA_DIR } else { Join-Path $env:TEMP "comet-dev-daemon" }
$UI_DIR = if ($env:COMET_DEV_UI_DIR) { $env:COMET_DEV_UI_DIR } else { Join-Path $env:TEMP "comet-dev-ui" }
$LOG_LEVEL = if ($env:RUST_LOG) { $env:RUST_LOG } else { "info" }

function Show-Usage {
    Write-Host "Developer entry point for Comet."
    Write-Host ""
    Write-Host "Usage:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/dev.ps1 run       # build and run the real Codex engine + headed app"
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/dev.ps1 watch     # rebuild and restart on source changes"
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/dev.ps1 demo      # run the seeded visual demo"
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/dev.ps1 check     # compile the workspace"
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/dev.ps1 test      # run workspace tests"
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/dev.ps1 fmt       # format the workspace"
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/dev.ps1 lint      # run clippy"
}

function Build-Comet {
    Write-Host "▸ building Comet..."
    Push-Location $ROOT
    try {
        cargo build -q -p comet
    } finally {
        Pop-Location
    }
}

function Run-Dev {
    Build-Comet

    # Ensure clean data directories exist
    New-Item -ItemType Directory -Force -Path $DAEMON_DIR | Out-Null
    New-Item -ItemType Directory -Force -Path $UI_DIR | Out-Null

    Write-Host "▸ starting local $HARNESS engine on :$PORT"
    # Save current env values
    $oldDataDir = $env:COMET_DATA_DIR
    $oldIpcPort = $env:COMET_IPC_PORT
    $oldEdgeToken = $env:COMET_EDGE_TOKEN
    $oldHarness = $env:COMET_HARNESS
    $oldRustLog = $env:RUST_LOG

    # Set env values temporarily so the child process inherits them
    $env:COMET_DATA_DIR = $DAEMON_DIR
    $env:COMET_IPC_PORT = $PORT
    $env:COMET_EDGE_TOKEN = $TOKEN
    $env:COMET_HARNESS = $HARNESS
    $env:RUST_LOG = $LOG_LEVEL

    $daemonProcess = Start-Process -FilePath "$ROOT\target\debug\agent-deski.exe" -ArgumentList "headless" -PassThru -NoNewWindow

    # Restore env values
    $env:COMET_DATA_DIR = $oldDataDir
    $env:COMET_IPC_PORT = $oldIpcPort
    $env:COMET_EDGE_TOKEN = $oldEdgeToken
    $env:COMET_HARNESS = $oldHarness
    $env:RUST_LOG = $oldRustLog

    try {
        # Wait for daemon port to be ready
        $connected = $false
        for ($i = 1; $i -le 40; $i++) {
            try {
                $tcpClient = New-Object System.Net.Sockets.TcpClient
                $tcpClient.Connect("127.0.0.1", $PORT)
                $tcpClient.Close()
                $connected = $true
                break
            } catch {
                Start-Sleep -Milliseconds 250
            }
        }

        if (-not $connected) {
            Write-Error "Failed to connect to local engine daemon on port $PORT"
            exit 1
        }

        Write-Host "▸ opening Comet"
        # Run headed app in foreground
        $env:COMET_DATA_DIR = $UI_DIR
        $env:COMET_IPC_PORT = $PORT
        $env:COMET_EDGE_TOKEN = $TOKEN
        $env:RUST_LOG = $LOG_LEVEL

        & "$ROOT\target\debug\agent-deski.exe"
    } finally {
        if ($daemonProcess -and -not $daemonProcess.HasExited) {
            Write-Host "▸ stopping local engine daemon"
            Stop-Process -Id $daemonProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

function Watch-Dev {
    if (-not (Get-Command "cargo-watch" -ErrorAction SilentlyContinue)) {
        Write-Error "cargo-watch is required for watch mode."
        Write-Host "Install it with: cargo install cargo-watch"
        exit 1
    }

    cargo watch -s "powershell -ExecutionPolicy Bypass -File `"$ROOT\scripts\dev.ps1`" run"
}

function Run-Demo {
    # Forward remaining arguments to dev-demo.ps1
    & (Join-Path $PSScriptRoot "dev-demo.ps1") @RemainingArgs
}

Push-Location $ROOT
try {
    switch ($Command) {
        "run"   { Run-Dev }
        "watch" { Watch-Dev }
        "demo"  { Run-Demo }
        "build" { Build-Comet }
        "check" { Build-Comet }
        "test"  { cargo test --workspace }
        "fmt"   { cargo fmt --all }
        "lint"  { cargo clippy --workspace --all-targets --all-features }
        "help"  { Show-Usage }
        "-h"    { Show-Usage }
        "--help"{ Show-Usage }
        default {
            Write-Error "Unknown command: $Command"
            Show-Usage
            exit 2
        }
    }
} finally {
    Pop-Location
}
