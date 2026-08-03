@echo off
chcp 65001 > nul
echo Starting UPDATE packaging process...
echo This will create a minimal package with only app.asar and updater.ps1
echo.
echo Step 1: Clearing mojang directory...
if exist mojang (
    echo Found mojang directory, deleting...
    rmdir /s /q mojang
    if errorlevel 1 (
        echo Failed to delete mojang directory
        pause
        exit /b 1
    )
    echo mojang directory deleted successfully
) else (
    echo mojang directory does not exist
)
echo.
echo Step 2: Creating mojang directory structure...
mkdir mojang
mkdir mojang\locales
mkdir mojang\resources
mkdir mojang\modelUser
mkdir mojang\modelUserLcb
echo Directory structure created successfully
echo.
echo Step 3: Copying updater.ps1...
if exist "updater.ps1" (
    copy "updater.ps1" "mojang\"
    if errorlevel 1 (
        echo Failed to copy updater.ps1
        pause
        exit /b 1
    )
    echo updater.ps1 copied successfully
) else (
    echo updater.ps1 not found
    pause
    exit /b 1
)
echo.
echo Step 4: Copying app.asar...
if exist "dist\win-unpacked\resources\app.asar" (
    copy "dist\win-unpacked\resources\app.asar" "mojang\resources\"
    if errorlevel 1 (
        echo Failed to copy app.asar
        pause
        exit /b 1
    )
    echo app.asar copied successfully
) else (
    echo dist\win-unpacked\resources\app.asar not found
    echo Please run build.bat first
    pause
    exit /b 1
)
echo.
echo Step 5: Copying modelUser folder...
if exist "modelUser" (
    xcopy /s /e /i /y "modelUser" "mojang\modelUser\"
    if errorlevel 1 (
        echo Failed to copy modelUser folder
        pause
        exit /b 1
    )
    echo modelUser folder copied successfully
) else (
    echo modelUser folder not found, skipping
)
echo.
echo Step 6: Copying modelUserLcb folder...
if exist "modelUserLcb" (
    xcopy /s /e /i /y "modelUserLcb" "mojang\modelUserLcb\"
    if errorlevel 1 (
        echo Failed to copy modelUserLcb folder
        pause
        exit /b 1
    )
    echo modelUserLcb folder copied successfully
) else (
    echo modelUserLcb folder not found, skipping
)
echo.
echo ====================================
echo UPDATE Packaging process completed successfully
echo Package location: mojang directory
echo Package contents: app.asar + updater.ps1 + User folders
echo This minimal package is for version updates only
echo ====================================
echo.
pause
