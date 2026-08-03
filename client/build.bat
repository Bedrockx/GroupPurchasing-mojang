@echo off
chcp 65001 > nul
echo Starting build process...
echo.
echo Step 1: Cleaning dist directory...
if exist dist (
    echo Found dist directory, deleting...
    rmdir /s /q dist
    if errorlevel 1 (
        echo Failed to delete dist directory
        pause
        exit /b 1
    )
    echo dist directory deleted successfully
) else (
    echo dist directory does not exist
)
echo.
echo Step 2: Running npm run build...
echo Please wait, this may take several minutes...
echo Current directory: %cd%
echo Running command: npm run build
call npm run build
if errorlevel 1 (
    echo npm run build failed
    echo Please check the npm output above for details
    pause
    exit /b 1
)
echo npm run build completed successfully
echo.
echo Build process completed successfully
echo You can find the built files in the dist directory
pause