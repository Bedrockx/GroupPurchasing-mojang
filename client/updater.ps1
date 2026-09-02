# Mojang client updater. Keep this file ASCII-only for Windows PowerShell 5.1.
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$UpdateZipPath,
    [Parameter(Mandatory = $true, Position = 1)]
    [string]$TargetDir,
    [Parameter(Position = 2)]
    [ValidateSet('main', 'groupPurchasing')]
    [string]$UpdateType = 'main',
    [Parameter(Position = 3)]
    [ValidateSet('true', 'false')]
    [string]$CloseMojang = 'false'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$shouldCloseMojang = $CloseMojang -eq 'true'
$script:ReadyMarkerPath = $null

function Write-UpdateLog {
    param([string]$Message)
    Write-Host $Message
    try {
        if ($script:TargetDir -and (Test-Path -LiteralPath $script:TargetDir -PathType Container)) {
            Add-Content -LiteralPath (Join-Path $script:TargetDir 'updater.log') -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" -Encoding UTF8
        }
    } catch {
        # Logging must not interrupt the update.
    }
}

function Remove-ReadyMarker {
    if (-not $script:ReadyMarkerPath) {
        return
    }

    try {
        if (Test-Path -LiteralPath $script:ReadyMarkerPath -PathType Leaf) {
            Remove-Item -LiteralPath $script:ReadyMarkerPath -Force -ErrorAction Stop
        }
    } catch {
        Write-UpdateLog "Failed to remove ready marker: $($_.Exception.Message)"
    }
}

function Stop-TargetMojangProcesses {
    $targetExePath = Join-Path $script:TargetDir 'mojang.exe'
    if (-not (Test-Path -LiteralPath $targetExePath -PathType Leaf)) {
        Write-UpdateLog 'Target mojang.exe was not found; process shutdown skipped.'
        return
    }

    $resolvedPath = [System.IO.Path]::GetFullPath($targetExePath)
    $deadline = (Get-Date).AddSeconds(15)
    do {
        $targetProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'mojang.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $resolvedPath) })
        if ($targetProcesses.Count -eq 0) {
            Write-UpdateLog 'All target mojang.exe processes have exited.'
            return
        }

        foreach ($processInfo in $targetProcesses) {
            Write-UpdateLog "Stopping target process PID=$($processInfo.ProcessId)."
            Stop-Process -Id $processInfo.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)

    $remaining = @(Get-CimInstance Win32_Process -Filter "Name = 'mojang.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $resolvedPath) })
    if ($remaining.Count -gt 0) {
        throw 'Target mojang.exe did not exit within 15 seconds.'
    }
}

function Assert-ZipEntriesSafe {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($script:UpdateZipPath)
    try {
        $targetRoot = ([System.IO.Path]::GetFullPath($script:TargetDir)).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        foreach ($entry in $archive.Entries) {
            $entryPath = [System.IO.Path]::GetFullPath((Join-Path $script:TargetDir $entry.FullName))
            if (-not $entryPath.StartsWith($targetRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Update archive contains an out-of-bounds path: $($entry.FullName)"
            }
        }
    } finally {
        $archive.Dispose()
    }
}

$exitCode = 1
try {
    $script:UpdateZipPath = [System.IO.Path]::GetFullPath($UpdateZipPath)
    $script:TargetDir = [System.IO.Path]::GetFullPath($TargetDir)
    $script:ReadyMarkerPath = "$script:UpdateZipPath.ready"
    Remove-ReadyMarker

    Write-UpdateLog 'Starting client update.'

    if (-not (Test-Path -LiteralPath $script:UpdateZipPath -PathType Leaf)) {
        throw "Update archive does not exist: $script:UpdateZipPath"
    }

    if (-not (Test-Path -LiteralPath $script:TargetDir -PathType Container)) {
        throw "Target directory does not exist: $script:TargetDir"
    }

    Write-UpdateLog "Update archive: $script:UpdateZipPath"
    Write-UpdateLog "Target directory: $script:TargetDir"
    Write-UpdateLog "Update type: $UpdateType"
    Write-UpdateLog "Close client process: $shouldCloseMojang"

    Assert-ZipEntriesSafe
    Write-UpdateLog 'Update archive validation passed.'

    # Signal only after all checks that must complete before the application exits.
    Set-Content -LiteralPath $script:ReadyMarkerPath -Value 'ready' -Encoding ASCII -Force
    Write-UpdateLog 'Updater ready marker created.'

    if ($shouldCloseMojang) {
        Start-Sleep -Seconds 2
        Stop-TargetMojangProcesses
    }

    if ($UpdateType -eq 'groupPurchasing') {
        $assetsPath = Join-Path $script:TargetDir 'assets'
        if (Test-Path -LiteralPath $assetsPath) {
            Write-UpdateLog "Removing old assets directory: $assetsPath"
            Remove-Item -LiteralPath $assetsPath -Recurse -Force -ErrorAction Stop
        }
    }

    Write-UpdateLog 'Extracting update archive.'
    Expand-Archive -LiteralPath $script:UpdateZipPath -DestinationPath $script:TargetDir -Force -ErrorAction Stop
    Write-UpdateLog 'Update archive extracted.'

    if ($UpdateType -eq 'main') {
        $mojangExePath = Join-Path $script:TargetDir 'mojang.exe'
        Write-UpdateLog "Starting client: $mojangExePath"
        if (-not (Test-Path -LiteralPath $mojangExePath -PathType Leaf)) {
            throw "Client executable does not exist: $mojangExePath"
        }

        Start-Process -FilePath $mojangExePath -WorkingDirectory $script:TargetDir -WindowStyle Minimized -ErrorAction Stop | Out-Null
        Write-UpdateLog 'Client started successfully.'
    } else {
        Write-UpdateLog 'Group purchasing update completed; client restart skipped.'
    }

    try {
        Remove-Item -LiteralPath $script:UpdateZipPath -Force -ErrorAction Stop
        Write-UpdateLog 'Temporary update archive removed.'
    } catch {
        Write-UpdateLog "Failed to remove temporary update archive: $($_.Exception.Message)"
    }

    Write-UpdateLog 'Update completed.'
    $exitCode = 0
} catch {
    Write-UpdateLog "Update failed: $($_.Exception.Message)"
} finally {
    Remove-ReadyMarker
}

exit $exitCode
