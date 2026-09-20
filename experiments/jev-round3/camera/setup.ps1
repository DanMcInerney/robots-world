$ErrorActionPreference = 'Stop'
$cameraRoot = Join-Path $PSScriptRoot '../../..'
$cameraRuntime = Join-Path $cameraRoot '.runtime/experiments/jev-round3-v1/camera'
$cameraPython = Join-Path $cameraRuntime 'env/Scripts/python.exe'
New-Item -ItemType Directory -Force (Join-Path $cameraRuntime 'assets') | Out-Null
if (-not (Test-Path -LiteralPath $cameraPython)) {
    uv venv --python 3.11 (Join-Path $cameraRuntime 'env')
    if ($LASTEXITCODE -ne 0) { throw 'Renderer environment creation failed' }
}
uv pip install --python $cameraPython -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Renderer dependency installation failed' }
$cameraAsset = Join-Path $cameraRuntime 'assets/ferrari.glb'
if (-not (Test-Path -LiteralPath $cameraAsset)) {
    Invoke-WebRequest 'https://raw.githubusercontent.com/mrdoob/three.js/6eec560494b0492cb72b6120ea2405bf4e4fe9c7/examples/models/gltf/ferrari.glb' -OutFile $cameraAsset
}
$cameraHash = (Get-FileHash -LiteralPath $cameraAsset -Algorithm SHA256).Hash.ToLowerInvariant()
if ($cameraHash -ne 'cafe3f48da6797aa9bde75ca768bc5b57db366575fd233e90df186ae988a876e') {
    throw "Unexpected Ferrari asset hash: $cameraHash"
}
Write-Output "Renderer ready: $cameraPython"
