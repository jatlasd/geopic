param([string]$PythonPath = "python")

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$venv = Join-Path $root ".venv"
$pythonExe = Join-Path $venv "Scripts/python.exe"
if (-not (Test-Path -LiteralPath $pythonExe)) {
    & $PythonPath -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "Creating the virtual environment failed. Pass -PythonPath with an installed Python executable." }
}
& $pythonExe -m pip install --disable-pip-version-check --no-cache-dir -r (Join-Path $root "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Installing the matching dependencies failed." }

$modelDir = Join-Path $root ".geo/models"
New-Item -Path $modelDir -ItemType Directory -Force | Out-Null
$release = "https://github.com/fabio-sim/LightGlue-ONNX/releases/download/v0.1.0"
$models = @(
    @{
        Name = "superpoint.onnx"
        Asset = "superpoint_2048.onnx"
        Hash = "DB98DB2E6AEA150B3F18297F979804911A0124822D638678A3E290086F2B5BD4"
    }
    @{
        Name = "lightglue.onnx"
        Asset = "superpoint_lightglue.onnx"
        Hash = "7FBB5814811DBC6D170DE1C86BC0352A14691EFA32CAE33D952B6039258F74EF"
    }
)
foreach ($model in $models) {
    $path = Join-Path $modelDir $model.Name
    if ((Test-Path -LiteralPath $path) -and
        (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $model.Hash) {
        continue
    }
    $partial = Join-Path $modelDir ($model.Name + ".partial")
    try {
        curl.exe -fsSL --retry 2 "$release/$($model.Asset)" -o $partial
        if ($LASTEXITCODE -ne 0) { throw "Downloading $($model.Asset) failed." }
        if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $model.Hash) {
            throw "Checksum mismatch for $($model.Asset)."
        }
        Move-Item -LiteralPath $partial -Destination $path -Force
    } finally {
        Remove-Item -LiteralPath $partial -ErrorAction SilentlyContinue
    }
}
$archiveDir = Join-Path $root "phase-1"
$photoDir = Join-Path $archiveDir "photos"
New-Item -Path $photoDir -ItemType Directory -Force | Out-Null
$catalog = Get-Content -LiteralPath (Join-Path $archiveDir "catalog.json") -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($photo in $catalog) {
    $path = Join-Path $photoDir (Split-Path -Leaf $photo.file)
    if (Test-Path -LiteralPath $path -PathType Leaf) { continue }
    $partial = $path + ".partial"
    try {
        curl.exe -fsSL --retry 2 --max-time 45 $photo.scan -o $partial
        if ($LASTEXITCODE -ne 0) { throw "Downloading photo $($photo.id) failed. Rerun setup to resume." }
        Move-Item -LiteralPath $partial -Destination $path -Force
    } finally {
        Remove-Item -LiteralPath $partial -ErrorAction SilentlyContinue
    }
}
Write-Output "Ready. Double-click Open Lab.cmd to open the lab."
