# 用户端更新器
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

function Write-UpdateLog {
    param([string]$Message)
    Write-Host $Message
    try {
        if ($script:TargetDir -and (Test-Path -LiteralPath $script:TargetDir -PathType Container)) {
            Add-Content -LiteralPath (Join-Path $script:TargetDir 'updater.log') -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" -Encoding UTF8
        }
    } catch {
        # 日志写入失败不应影响更新流程
    }
}

function Stop-TargetMojangProcesses {
    $targetExePath = Join-Path $script:TargetDir 'mojang.exe'
    if (-not (Test-Path -LiteralPath $targetExePath -PathType Leaf)) {
        Write-UpdateLog '未找到目标 mojang.exe，跳过进程关闭。'
        return
    }

    $resolvedPath = [System.IO.Path]::GetFullPath($targetExePath)
    $deadline = (Get-Date).AddSeconds(15)
    do {
        $targetProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'mojang.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $resolvedPath) })
        if ($targetProcesses.Count -eq 0) {
            Write-UpdateLog '目标目录中的 mojang.exe 已全部退出。'
            return
        }

        foreach ($processInfo in $targetProcesses) {
            Write-UpdateLog "关闭目标进程 PID=$($processInfo.ProcessId)。"
            Stop-Process -Id $processInfo.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)

    $remaining = @(Get-CimInstance Win32_Process -Filter "Name = 'mojang.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $resolvedPath) })
    if ($remaining.Count -gt 0) {
        throw "目标目录中的 mojang.exe 未能在15秒内退出。"
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
                throw "更新包包含越界路径: $($entry.FullName)"
            }
        }
    } finally {
        $archive.Dispose()
    }
}

Write-UpdateLog '开始执行用户端更新。'

try {
    $script:UpdateZipPath = [System.IO.Path]::GetFullPath($UpdateZipPath)
    $script:TargetDir = [System.IO.Path]::GetFullPath($TargetDir)
} catch {
    Write-UpdateLog "参数路径无效: $($_.Exception.Message)"
    exit 1
}

if (-not (Test-Path -LiteralPath $script:UpdateZipPath -PathType Leaf)) {
    Write-UpdateLog "更新包不存在: $script:UpdateZipPath"
    exit 1
}

if (-not (Test-Path -LiteralPath $script:TargetDir -PathType Container)) {
    Write-UpdateLog "目标目录不存在: $script:TargetDir"
    exit 1
}

Write-UpdateLog "更新包: $script:UpdateZipPath"
Write-UpdateLog "目标目录: $script:TargetDir"
Write-UpdateLog "更新类型: $UpdateType"
Write-UpdateLog "关闭用户端进程: $shouldCloseMojang"

# 仅关闭目标目录中的用户端进程，避免误杀其他安装目录的实例
if ($shouldCloseMojang) {
    Start-Sleep -Seconds 2
    try {
        Stop-TargetMojangProcesses
    } catch {
        Write-UpdateLog "关闭用户端进程失败: $($_.Exception.Message)"
        exit 1
    }
}

# 校验压缩包路径后仍直接覆盖目标目录
try {
    Assert-ZipEntriesSafe
    Write-UpdateLog '更新包路径校验通过。'

    # 团购更新需要先删除旧 assets 目录
    if ($updateType -eq "groupPurchasing") {
        $assetsPath = Join-Path $script:TargetDir "assets"
        if (Test-Path -LiteralPath $assetsPath) {
            Write-UpdateLog "删除旧 assets 目录: $assetsPath"
            Remove-Item -LiteralPath $assetsPath -Recurse -Force -ErrorAction Stop
        }
    }
    
    Write-UpdateLog '开始覆盖解压更新包。'
    Expand-Archive -LiteralPath $script:UpdateZipPath -DestinationPath $script:TargetDir -Force -ErrorAction Stop
    Write-UpdateLog '更新包解压完成。'
} catch {
    Write-UpdateLog "更新包处理失败: $($_.Exception.Message)"
    exit 1
}

# 更新主程序时启动新进程；团购更新不启动主程序
if ($updateType -eq "main") {
    $mojangExePath = Join-Path $script:TargetDir "mojang.exe"
    Write-UpdateLog "启动用户端: $mojangExePath"
    if (Test-Path -LiteralPath $mojangExePath -PathType Leaf) {
        try {
            Start-Process -FilePath $mojangExePath -WorkingDirectory $script:TargetDir -WindowStyle Minimized -ErrorAction Stop | Out-Null
            Write-UpdateLog '用户端启动成功。'
        } catch {
            Write-UpdateLog "启动用户端失败: $($_.Exception.Message)"
            exit 1
        }
    } else {
        Write-UpdateLog "用户端程序不存在: $mojangExePath"
        exit 1
    }
} else {
    Write-UpdateLog '团购更新完成，跳过启动用户端。'
}

# 仅在更新流程完成后删除下载包，失败时保留现场便于排查
try {
    Remove-Item -LiteralPath $script:UpdateZipPath -Force -ErrorAction Stop
    Write-UpdateLog '临时更新包清理完成。'
} catch {
    Write-UpdateLog "临时更新包清理失败: $($_.Exception.Message)"
}

Write-UpdateLog '更新流程完成。'
exit 0
