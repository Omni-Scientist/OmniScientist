[CmdletBinding()]
param([switch]$PurgeData)

$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "install.ps1") -Uninstall:$true -PurgeData:$PurgeData
