$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $nodeVersion = & node.exe -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.19.0') {
        throw 'Install Node.js 22.19 or newer from https://nodejs.org/ first.'
    }
    $manager = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json).packageManager
    & npm.cmd install --global $manager
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the required pnpm version.' }
    & pnpm.cmd install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    & pnpm.cmd build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    Write-Host 'Ready. Run .\habor.cmd to start habor.'
} finally {
    Pop-Location
}
