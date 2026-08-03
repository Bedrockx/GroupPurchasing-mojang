@echo off
chcp 65001 > nul
echo Starting FULL packaging process...
echo This will create a complete package with all dependencies
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
echo Step 2: Copying files from dist\win-unpacked to mojang...
if exist "dist\win-unpacked" (
    echo Found dist\win-unpacked directory, copying...
    mkdir mojang
    xcopy /s /e /i /y "dist\win-unpacked\*" "mojang\"
    if errorlevel 1 (
        echo Failed to copy files
        pause
        exit /b 1
    )
    echo Files copied successfully
) else (
    echo dist\win-unpacked directory does not exist
    echo Please run build.bat first
    pause
    exit /b 1
)
echo.
echo Step 3: Creating namePng directory in mojang...
mkdir "mojang\namePng"
if errorlevel 1 (
    echo Failed to create namePng directory
    pause
    exit /b 1
)
echo namePng directory created successfully
echo.
echo Step 4: Copying template User folder to mojang...
if exist "modelUser" (
    echo Found modelUser directory, copying...
    xcopy /s /e /i /y "modelUser" "mojang\modelUser\"
    if errorlevel 1 (
        echo Failed to copy template User folder
        pause
        exit /b 1
    )
    echo Template User folder copied successfully
) else (
    echo modelUser directory does not exist
    echo Skipping this step
)
echo.
echo Step 5: Copying LCB template User folder to mojang...
if exist "modelUserLcb" (
    echo Found modelUserLcb directory, copying...
    xcopy /s /e /i /y "modelUserLcb" "mojang\modelUserLcb\"
    if errorlevel 1 (
        echo Failed to copy LCB template User folder
        pause
        exit /b 1
    )
    echo LCB Template User folder copied successfully
) else (
    echo modelUserLcb directory does not exist
    echo Skipping this step
)
echo.
echo Step 6: Copying update script to mojang...
if exist "updater.ps1" (
    echo Found updater.ps1, copying...
    copy "updater.ps1" "mojang\"
    if errorlevel 1 (
        echo Failed to copy update script
        pause
        exit /b 1
    )
    echo Update script copied successfully
) else (
    echo updater.ps1 does not exist
    echo Skipping this step
)
echo.
echo ====================================
echo FULL Packaging process completed successfully
echo You can find the complete package in the mojang directory
echo This package includes all dependencies
echo ====================================
echo.
pause
