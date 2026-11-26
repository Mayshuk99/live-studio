@echo off
rem Build DE-FEEDBACK (VST3 + Standalone) on Windows.
rem Needs: Visual Studio 2022 or newer with "Desktop development with C++", and Git.
rem The first run downloads JUCE (internet required once).

cd /d "%~dp0"

cmake -B build -A x64
if errorlevel 1 goto :error

cmake --build build --config Release --target DefeedbackPlugin_VST3 DefeedbackPlugin_Standalone
if errorlevel 1 goto :error

echo.
echo ==========================================================
echo  Done!
echo  VST3:       build\DefeedbackPlugin_artefacts\Release\VST3\DE-FEEDBACK.vst3
echo  Standalone: build\DefeedbackPlugin_artefacts\Release\Standalone\DE-FEEDBACK.exe
echo.
echo  Copy DE-FEEDBACK.vst3 to:  C:\Program Files\Common Files\VST3\
echo ==========================================================
pause
exit /b 0

:error
echo.
echo BUILD FAILED - see the messages above.
pause
exit /b 1
