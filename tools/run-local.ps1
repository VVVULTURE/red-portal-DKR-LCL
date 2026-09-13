# Runs Red Portal from this checkout on http://127.0.0.1:8811/ with the real
# game lists (read from the public manifest on R2 -- no keys needed).
#
#   powershell -ExecutionPolicy Bypass -File tools\run-local.ps1
#
# Optional: set R2_ACCOUNT_ID / R2_LIST_ACCESS_KEY_ID / R2_LIST_SECRET_ACCESS_KEY /
# R2_BUCKET in your shell first and the Emulation and Movies lists fill in too
# (they are live bucket listings, not manifest-backed). Without them those two
# sections are simply empty locally.
#
# Theme layers load from assets/themes/<Folder>/ in this checkout when the
# page is on localhost (see art-manifest.json "layerBaseLocal"); on the real
# site they come from R2 after a sync.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host 'node_modules missing -- run: npm ci   (or link the sync folder''s node_modules)'
  exit 1
}
$env:PORT = '8811'
$env:R2_PUBLIC_DOMAIN = 'assets.redportal.dpdns.org'
$env:SELF_PING_ENABLED = '0'
Write-Host ''
Write-Host '  Red Portal (local)  ->  http://127.0.0.1:8811/'
Write-Host '  Ctrl+C stops it.'
Write-Host ''
node server.js
