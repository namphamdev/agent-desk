<#
.SYNOPSIS
    One-command demo: boots a seeded engine daemon + the headed app, offline.
    Made for judging look & feel with real input — no edge, no auth needed.

.DESCRIPTION
    scripts/dev-demo.ps1            # build, seed demo data, open the app
    scripts/dev-demo.ps1 --slow     # pace mock streams (~10s) to watch streaming
#>

param(
    [switch]$Slow
)

$ErrorActionPreference = "Stop"

# Get absolute path of workspace root
$ROOT = Resolve-Path (Join-Path $PSScriptRoot "..")
$DAEMON_DIR = Join-Path $env:TEMP "comet-demo-daemon"
$UI_DIR = Join-Path $env:TEMP "comet-demo-ui"
$IPC = 27921
$DEMO_TOKEN = "demo@demo-org"

Write-Host "▸ building (first run takes a few minutes)…"
Push-Location $ROOT
try {
    cargo build -p comet -q
} finally {
    Pop-Location
}

# Ensure clean/created directories
New-Item -ItemType Directory -Force -Path $DAEMON_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $UI_DIR | Out-Null

Write-Host "▸ starting engine daemon on :$IPC"
    # Save current env values
    $oldDataDir = $env:COMET_DATA_DIR
    $oldIpcPort = $env:COMET_IPC_PORT
    $oldHarness = $env:COMET_HARNESS
    $oldEdgeToken = $env:COMET_EDGE_TOKEN
    $oldRustLog = $env:RUST_LOG
    $oldMockDelay = $env:COMET_MOCK_DELAY_MS

    # Set env values temporarily so the child process inherits them
    $env:COMET_DATA_DIR = $DAEMON_DIR
    $env:COMET_IPC_PORT = $IPC
    $env:COMET_HARNESS = "mock"
    $env:COMET_EDGE_TOKEN = $DEMO_TOKEN
    $env:RUST_LOG = "warn"
    if ($Slow) {
        $env:COMET_MOCK_DELAY_MS = "350"
    } else {
        $env:COMET_MOCK_DELAY_MS = $null
    }

    $daemonProcess = Start-Process -FilePath "$ROOT\target\debug\agent-deski.exe" -ArgumentList "headless" -PassThru -NoNewWindow

    # Restore env values
    $env:COMET_DATA_DIR = $oldDataDir
    $env:COMET_IPC_PORT = $oldIpcPort
    $env:COMET_HARNESS = $oldHarness
    $env:COMET_EDGE_TOKEN = $oldEdgeToken
    $env:RUST_LOG = $oldRustLog
    $env:COMET_MOCK_DELAY_MS = $oldMockDelay

function probe {
    param(
        [string]$method,
        [string]$payload
    )
    # Run the probe example from target/debug
    $res = cargo run -q -p comet-rpc --example rpc_probe -- "ws://127.0.0.1:$IPC" $method $payload
    return ($res | Out-String).Trim()
}

try {
    # Wait for daemon port to be ready
    $connected = $false
    for ($i = 1; $i -le 40; $i++) {
        try {
            $tcpClient = New-Object System.Net.Sockets.TcpClient
            $tcpClient.Connect("127.0.0.1", $IPC)
            $tcpClient.Close()
            $connected = $true
            break
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }

    if (-not $connected) {
        Write-Error "Failed to connect to local demo daemon on port $IPC"
        exit 1
    }

    $seededFile = Join-Path $DAEMON_DIR ".demo-seeded"
    if (-not (Test-Path $seededFile)) {
        Write-Host "▸ seeding demo chats"
        
        $deviceInfoJson = probe LocalDevice '{}'
        $deviceInfo = $deviceInfoJson | ConvertFrom-Json
        $DEV = $deviceInfo.deviceId

        $SPACES = @{}
        foreach ($project in "comet-native", "soccertcg", "comet", "aether") {
            $sid = [guid]::NewGuid().ToString().ToLower()
            # Construct folder path under current user's profile github folder
            $mutatePayload = @{
                op = "createSpace"
                spaceId = $sid
                deviceId = $DEV
                path = "$env:USERPROFILE\github\$project"
            } | ConvertTo-Json -Compress
            $null = probe Mutate $mutatePayload
            $SPACES[$project] = $sid
        }

        function Seed-Chat {
            param(
                [string]$title,
                [string]$project,
                [string]$branch,
                [int]$ageHours,
                [string]$action
            )
            $id = [guid]::NewGuid().ToString().ToLower()
            $sid = $SPACES[$project]
            
            $createChatPayload = @{
                op = "createChat"
                chatId = $id
                spaceId = $sid
                config = @{
                    harness = "mock"
                    model = "fable-5"
                    reasoning = $null
                    sandbox = "workspace-write"
                }
            } | ConvertTo-Json -Compress
            $null = probe Mutate $createChatPayload

            $renameChatPayload = @{
                op = "renameChat"
                chatId = $id
                title = $title
            } | ConvertTo-Json -Compress
            $null = probe Mutate $renameChatPayload

            $setBranchPayload = @{
                op = "setChatBranch"
                chatId = $id
                branch = $branch
            } | ConvertTo-Json -Compress
            $null = probe Mutate $setBranchPayload

            if ($action -eq "run") {
                $msgId = [guid]::NewGuid().ToString().ToLower()
                $queueCmdPayload = @{
                    chatId = $id
                    command = @{
                        kind = "run"
                        messageId = $msgId
                        request = @{
                            prompt = "Walk me through the streaming pipeline"
                            model = $null
                            reasoning = $null
                            modelOptions = @{}
                            cwd = "$env:TEMP"
                            sandbox = "workspace-write"
                            autoApprove = $true
                            resume = $null
                        }
                    }
                } | ConvertTo-Json -Compress
                $null = probe QueueCommand $queueCmdPayload
                Start-Sleep -Seconds 1
            }

            # Calculate lastMessageAt timestamp in milliseconds
            $epoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
            $timestamp = ($epoch - ($ageHours * 3600)) * 1000
            
            $setActivityPayload = @{
                op = "setChatActivity"
                chatId = $id
                lastMessageAt = [long]$timestamp
            } | ConvertTo-Json -Compress
            $null = probe Mutate $setActivityPayload
        }

        Seed-Chat "Native Comet Rust Rewrite"    "comet-native" "comet-native/main"                 0  "run"
        Seed-Chat "Rebalance Player Stats Caps"  "soccertcg"    "comet/rebalance-player-stat-caps"  2  "run"
        Seed-Chat "Craft Premium TCG Experience" "soccertcg"    "comet/craft-premium-tcg-exp"       26 "skip"
        Seed-Chat "Initial Context Exploration"  "comet"        "comet/initial-context-exploration" 14 "skip"
        Seed-Chat "Soccer TCG Repo Creation"     "aether"       "aether/main"                       48 "skip"

        New-Item -ItemType File -Path $seededFile -Value "seeded" | Out-Null
    }

    Write-Host "▸ opening comet (composer is live — type into it; --slow shows streaming)"
    $env:COMET_DATA_DIR = $UI_DIR
    $env:COMET_IPC_PORT = $IPC
    $env:COMET_EDGE_TOKEN = $DEMO_TOKEN
    $env:RUST_LOG = "warn"
    
    & "$ROOT\target\debug\agent-deski.exe"
} finally {
    if ($daemonProcess -and -not $daemonProcess.HasExited) {
        Write-Host "▸ stopping engine daemon"
        Stop-Process -Id $daemonProcess.Id -Force -ErrorAction SilentlyContinue
    }
}
