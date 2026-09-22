$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Please install Node.js 22 or newer.' }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { Write-Warning 'FFmpeg is not on PATH. Video composition requires ffmpeg and ffprobe.' }
if (-not (Test-Path -LiteralPath 'node_modules')) { npm.cmd ci; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
npm.cmd run dev
