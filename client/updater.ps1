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
    [string]$CloseMojang = 'false',
    [Parameter(Position = 4)]
    [ValidateSet('standalone', 'handshake')]
    [string]$Coordination = 'standalone'
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

function Get-ChildPath {
    param([string]$Root, [string]$Relative)
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if ([IO.Path]::IsPathRooted($Relative) -or $Relative.Contains(':')) { throw "Invalid member path: $Relative" }
    $full = [IO.Path]::GetFullPath([IO.Path]::Combine($base, $Relative))
    if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw "Path outside target: $Relative" }
    $cursor = $full
    while ($cursor.Length -ge $base.Length) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing to update through a link: $cursor"
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $full
}

function Install-Member {
    param([string]$Relative, [bool]$RemoveOnly = $false)
    $dest = Get-ChildPath $script:TargetDir $Relative
    $old = Get-ChildPath $backup $Relative
    if (Test-Path -LiteralPath $dest -PathType Container) { throw "File conflicts with a directory: $dest" }
    if (Test-Path -LiteralPath $dest -PathType Leaf) {
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($old))
        [IO.File]::Move($dest, $old)
    }
    $changes.Add($Relative)
    if (-not $RemoveOnly) {
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest))
        [IO.File]::Move((Get-ChildPath $stage $Relative), $dest)
    }
}

function Test-UserFile {
    param([string]$Relative)
    if ($Relative -match '^(records|targets)\\') { return $true }
    if ($runtimeNames -contains $Relative) { return $true }
    foreach ($pattern in $savedPatterns) {
        if ($Relative -like $pattern.Replace('/', '\')) { return $true }
    }
    return $false
}

$changes = New-Object 'System.Collections.Generic.List[string]'
$work = $null
$rollbackFailed = $false
$lock = $null
$exitCode = 1
try {
    $script:UpdateZipPath = [System.IO.Path]::GetFullPath($UpdateZipPath)
    $script:TargetDir = [System.IO.Path]::GetFullPath($TargetDir).TrimEnd('\')
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
    $lockPath = Get-ChildPath $script:TargetDir '.mojang-update.lock'
    $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
    $work = Get-ChildPath $script:TargetDir ('.mojang-update-' + [Guid]::NewGuid().ToString('N'))
    $stage = Get-ChildPath $work 'stage'
    $backup = Get-ChildPath $work 'backup'
    [void][IO.Directory]::CreateDirectory($stage)
    Expand-Archive -LiteralPath $script:UpdateZipPath -DestinationPath $stage -ErrorAction Stop
    $savedPatterns = @()
    $runtimeNames = @('command.json', (([string][char]0x5339 + [char]0x914d + [char]0x4fe1 + [char]0x606f) + '.json'),
        (([string][char]0x8fd0 + [char]0x884c + [char]0x7ed3 + [char]0x679c) + '.txt'))
    if ($UpdateType -eq 'groupPurchasing') {
        $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Get-ChildPath $stage 'manifest.json') | ConvertFrom-Json
        if (-not $manifest.main -or -not (Test-Path -LiteralPath (Get-ChildPath $stage $manifest.main) -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Get-ChildPath $stage 'assets') -PathType Container)) { throw 'Incomplete group purchasing package.' }
        $savedPatterns = @($manifest.saved_files | Where-Object { $_ -is [string] })
        $oldManifest = Get-ChildPath $script:TargetDir 'manifest.json'
        if (Test-Path -LiteralPath $oldManifest -PathType Leaf) {
            $previous = Get-Content -Raw -Encoding UTF8 -LiteralPath $oldManifest | ConvertFrom-Json
            $savedPatterns += @($previous.saved_files | Where-Object { $_ -is [string] })
        }
        $savedPatterns += 'assets\targetItems\' + [char]0x4fdd + [char]0x7559 + '\*'
    } elseif (-not (Test-Path -LiteralPath (Get-ChildPath $stage 'resources\app.asar') -PathType Leaf)) {
        throw 'Incomplete client package.'
    }
    Write-UpdateLog 'Update archive validation passed.'

    # Signal only after all checks that must complete before the application exits.
    Set-Content -LiteralPath $script:ReadyMarkerPath -Value 'ready' -Encoding ASCII -Force
    Write-UpdateLog 'Updater ready marker created.'
    if ($Coordination -eq 'handshake') {
        $deadline = [DateTime]::UtcNow.AddMinutes(1)
        while (-not (Test-Path -LiteralPath "$script:UpdateZipPath.commit" -PathType Leaf)) {
            if ((Test-Path -LiteralPath "$script:UpdateZipPath.cancel") -or [DateTime]::UtcNow -ge $deadline) {
                throw 'Update cancelled before installation.'
            }
            Start-Sleep -Milliseconds 100
        }
    }

    if ($shouldCloseMojang) {
        Start-Sleep -Seconds 2
        Stop-TargetMojangProcesses
    }

    $files = @(Get-ChildItem -LiteralPath $stage -Recurse -File -Force)
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($stage.Length + 1)
        if ($relative -like '.mojang-update*' -or (Get-ChildPath $script:TargetDir $relative) -ieq $script:UpdateZipPath) { throw "Reserved update path: $relative" }
        if ($UpdateType -eq 'groupPurchasing' -and (Test-UserFile $relative) -and
            (Test-Path -LiteralPath (Get-ChildPath $script:TargetDir $relative))) { continue }
        Install-Member $relative
    }
    $assets = Get-ChildPath $script:TargetDir 'assets'
    if ($UpdateType -eq 'groupPurchasing' -and (Test-Path -LiteralPath $assets -PathType Container)) {
        $published = @{}
        foreach ($file in $files) { $published[$file.FullName.Substring($stage.Length + 1)] = $true }
        foreach ($file in @(Get-ChildItem -LiteralPath $assets -Recurse -File -Force)) {
            $relative = $file.FullName.Substring($script:TargetDir.Length + 1)
            if (-not $published.ContainsKey($relative) -and -not (Test-UserFile $relative)) { Install-Member $relative $true }
        }
    }

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
    for ($i = $changes.Count - 1; $i -ge 0; $i--) {
        try {
            $relative = $changes[$i]
            $dest = Get-ChildPath $script:TargetDir $relative
            $old = Get-ChildPath $backup $relative
            if (Test-Path -LiteralPath $dest -PathType Leaf) { [IO.File]::Delete($dest) }
            if (Test-Path -LiteralPath $old -PathType Leaf) { [IO.File]::Move($old, $dest) }
        } catch {
            $rollbackFailed = $true
            Write-UpdateLog "Recovery failed; retained backup in ${backup}: $($_.Exception.Message)"
        }
    }
} finally {
    if ($work -and -not $rollbackFailed -and (Test-Path -LiteralPath $work -PathType Container)) {
        try {
            $verified = Get-ChildPath $script:TargetDir ([IO.Path]::GetFileName($work))
            if ($verified -ieq $work -and [IO.Path]::GetFileName($work) -match '^\.mojang-update-[a-f0-9]{32}$') {
                Remove-Item -LiteralPath $verified -Recurse -Force
            }
        } catch { Write-UpdateLog "Temporary files retained: $work" }
    }
    if ($lock) { $lock.Dispose() }
    Remove-ReadyMarker
    if ($Coordination -eq 'handshake' -and $exitCode -eq 0) {
        foreach ($suffix in @('.commit', '.cancel')) {
            $marker = "$script:UpdateZipPath$suffix"
            if (Test-Path -LiteralPath $marker -PathType Leaf) { Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue }
        }
        $parent = [IO.Path]::GetDirectoryName($script:UpdateZipPath)
        if ([IO.Path]::GetFileName($parent) -match '^mojang-update-[a-zA-Z0-9]+$' -and
            [IO.Path]::GetDirectoryName($parent) -ieq [IO.Path]::GetTempPath().TrimEnd('\')) {
            try { [IO.Directory]::Delete($parent, $false) } catch {}
        }
    }
}

exit $exitCode
