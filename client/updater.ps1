# Updater Script - PowerShell Version

# Ensure script runs in window
if (-not $Host.UI.RawUI.WindowTitle) {
    Start-Process powershell.exe -ArgumentList "-ExecutionPolicy Bypass -File '$PSCommandPath' $($args -join ' ')" -WindowStyle Minimized
    exit
}

# Clear screen
Clear-Host

# Show title
Write-Host "====================================" -ForegroundColor Cyan
Write-Host "        Mojang Updater" -ForegroundColor Green
Write-Host "====================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "Starting update..." -ForegroundColor Green
Write-Host ""

# Get parameters
$updateZipPath = $args[0]
$targetDir = $args[1]
$updateType = $args[2]
$closeMojang = $args[3] -eq "true"

if (-not $updateZipPath) {
    Write-Host "Error: Missing update package path" -ForegroundColor Red
    Read-Host "Press Enter to exit..."
    exit 1
}

if (-not $targetDir) {
    Write-Host "Error: Missing target directory" -ForegroundColor Red
    Read-Host "Press Enter to exit..."
    exit 1
}

Write-Host "Update package path: $updateZipPath" -ForegroundColor Cyan
Write-Host "Target directory: $targetDir" -ForegroundColor Cyan
Write-Host "Update type: $updateType" -ForegroundColor Cyan
Write-Host "Close mojang.exe: $closeMojang" -ForegroundColor Cyan
Write-Host ""

# Check if file exists
if (-not (Test-Path $updateZipPath)) {
    Write-Host "Error: Update package not found: $updateZipPath" -ForegroundColor Red
    Read-Host "Press Enter to exit..."
    exit 1
}

# Check if target directory exists
if (-not (Test-Path $targetDir)) {
    Write-Host "Error: Target directory not found: $targetDir" -ForegroundColor Red
    Read-Host "Press Enter to exit..."
    exit 1
}

# Close mojang.exe processes by exact path (fix multi-instance issue)
if ($closeMojang -eq "true") {
    Write-Host "Waiting 3 seconds before checking for running mojang.exe processes..." -ForegroundColor Yellow
    Start-Sleep -Seconds 3
    
    Write-Host "Finding mojang.exe processes in target directory..." -ForegroundColor Yellow
    
    $targetExePath = Join-Path $targetDir "mojang.exe"
    $resolvedPath = (Resolve-Path $targetExePath -ErrorAction SilentlyContinue).Path
    
    if (-not $resolvedPath) {
        Write-Host "Target file not found, no need to close" -ForegroundColor Yellow
    } else {
        # Loop until no matching processes (handle multi-instance + rapid process changes)
        $maxAttempts = 5
        $attempt = 0
        $hasError = $false
        
        while ($attempt -lt $maxAttempts) {
            # Re-query each loop to avoid stale objects
            $targetProcesses = Get-CimInstance Win32_Process -Filter "Name = 'mojang.exe'" | 
                Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $resolvedPath) }
            
            if (-not $targetProcesses) {
                Write-Host "All mojang.exe processes in target directory closed" -ForegroundColor Green
                break
            }
            
            foreach ($proc in $targetProcesses) {
                Write-Host "Found target process: PID=$($proc.ProcessId) Path=$($proc.ExecutablePath)" -ForegroundColor Yellow
                
                try {
                    # Method 1: Use Stop-Process (most reliable)
                    Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
                    Write-Host "Terminated process PID: $($proc.ProcessId)" -ForegroundColor Green
                } catch {
                    # Method 2: If Stop-Process fails, use taskkill /F /PID
                    Write-Host "Stop-Process failed, trying taskkill PID: $($proc.ProcessId)..." -ForegroundColor Yellow
                    $taskkillResult = & taskkill /F /PID $proc.ProcessId 2>&1
                    if ($LASTEXITCODE -eq 0) {
                        Write-Host "Taskkill successfully terminated PID: $($proc.ProcessId)" -ForegroundColor Green
                    } else {
                        Write-Host "Warning: Failed to terminate PID $($proc.ProcessId): $taskkillResult" -ForegroundColor Red
                        $hasError = $true
                    }
                }
            }
            
            $attempt++
            if ($attempt -lt $maxAttempts) {
                Start-Sleep -Milliseconds 500  # Short wait before re-query
            }
        }
        
        if ($hasError -and $attempt -ge $maxAttempts) {
            Write-Host "Error: Some processes could not be terminated, update may fail" -ForegroundColor Red
            Read-Host "Press Enter to exit..."
            exit 1
        }
    }
}

# Extract update package
Write-Host "Extracting update package..." -ForegroundColor Yellow
try {
    # For ArtifactsGroupPurchasing update, delete assets folder first
    if ($updateType -eq "groupPurchasing") {
        $assetsPath = Join-Path $targetDir "assets"
        if (Test-Path $assetsPath) {
            Write-Host "Deleting existing assets folder: $assetsPath" -ForegroundColor Yellow
            Remove-Item -Path $assetsPath -Recurse -Force -ErrorAction Stop
            Write-Host "Assets folder deleted successfully" -ForegroundColor Green
        }
    }
    
    Write-Host "Executing: Expand-Archive -Path '$updateZipPath' -DestinationPath '$targetDir' -Force" -ForegroundColor Gray
    Expand-Archive -Path $updateZipPath -DestinationPath $targetDir -Force -ErrorAction Stop
    Write-Host "Extraction successful" -ForegroundColor Green
} catch {
    Write-Host "Extraction failed: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host "Press Enter to exit..."
    exit 1
}

# Start mojang.exe using cmd /c (avoid PowerShell waiting for child process)
if ($updateType -eq "main") {
    $mojangExePath = Join-Path $targetDir "mojang.exe"
    Write-Host "Starting mojang.exe: $mojangExePath" -ForegroundColor Yellow
    if (Test-Path $mojangExePath) {
        try {
            # Use cmd /c to start, completely detach from current PowerShell process
            $cmdArgs = "/c cd /d `"$targetDir`" && start /min `"`" `"mojang.exe`""
            Write-Host "Executing: cmd.exe $cmdArgs" -ForegroundColor Gray
            
            Start-Process -FilePath "cmd.exe" -ArgumentList $cmdArgs -WindowStyle Hidden
            
            Write-Host "Start successful" -ForegroundColor Green
            Write-Host "Updater will exit now, mojang.exe will continue running" -ForegroundColor Cyan
            Start-Sleep -Milliseconds 300
        } catch {
            Write-Host "Start failed: $($_.Exception.Message)" -ForegroundColor Red
            Read-Host "Press Enter to exit..."
            exit 1
        }
    } else {
        Write-Host "Error: mojang.exe not found: $mojangExePath" -ForegroundColor Red
        Read-Host "Press Enter to exit..."
        exit 1
    }
} else {
    Write-Host "Update type is not main, skipping mojang.exe start" -ForegroundColor Yellow
}

# Clean temporary files
Write-Host "Cleaning temporary files..." -ForegroundColor Yellow
try {
    if (Test-Path $updateZipPath) {
        Remove-Item -Path $updateZipPath -Force -ErrorAction Stop
        Write-Host "Cleaning successful" -ForegroundColor Green
    } else {
        Write-Host "File not found, no cleaning needed" -ForegroundColor Yellow
    }
} catch {
    Write-Host "Warning: Cleaning failed, file may be in use: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "====================================" -ForegroundColor Cyan
Write-Host "        Update Complete!" -ForegroundColor Green
Write-Host "====================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Window will close automatically in 3 seconds, or press Enter to close immediately..." -ForegroundColor Yellow

# Wait for 3 seconds, can be interrupted by Enter key
$waitSeconds = 3
$startTime = Get-Date

while (((Get-Date) - $startTime).TotalSeconds -lt $waitSeconds) {
    # Check if key is pressed
    if ($host.UI.RawUI.KeyAvailable) {
        $key = $host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
        # Only respond to Enter key
        if ($key.VirtualKeyCode -eq 13) {
            Write-Host ""
            Write-Host "Enter key detected, closing..." -ForegroundColor Green
            break
        }
    }
    Start-Sleep -Milliseconds 100
}

exit 0