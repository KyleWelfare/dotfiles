# Installs the toolchain and links this repo's configs into place. Safe to rerun.
#   powershell -ExecutionPolicy Bypass -File .\windows\bootstrap.ps1
# -Configure reruns the per-machine setup questions (shared/setup.ts).
param([switch]$SkipInstall, [switch]$Configure)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent

function Update-SessionPath {
    $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('PATH', 'User')
}

if (-not $SkipInstall) {
    Get-Content "$PSScriptRoot\winget.txt" | Where-Object { $_.Trim() } | ForEach-Object {
        $id = $_.Trim()
        winget list --id $id --exact --accept-source-agreements *> $null
        if ($LASTEXITCODE -eq 0) { Write-Host "ok      $id"; return }
        Write-Host "install $id"
        winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements
    }
    Update-SessionPath
    if (-not (Get-Command bun -EA SilentlyContinue))    { Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression }
    if (-not (Get-Command claude -EA SilentlyContinue)) { Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression }
}

# A fresh machine only has Windows PowerShell 5.1, whose New-Item can't make
# unprivileged symlinks and whose $PROFILE/module paths aren't pwsh 7's.
if ($PSVersionTable.PSVersion.Major -lt 7) {
    Update-SessionPath
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -SkipInstall -Configure:$Configure
    exit $LASTEXITCODE
}

$devMode = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -EA SilentlyContinue).AllowDevelopmentWithoutDevLicense -eq 1
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
$canLink = $devMode -or $isAdmin
if (-not $canLink) {
    Write-Warning ("Developer Mode is off, so configs are copied instead of linked and edits won't flow back to the repo. " +
                   "Turn it on in Settings > System > For developers and rerun to switch to links.")
}

function Install-Config([string]$source, [string]$target) {
    $source = Join-Path $repo $source
    $existing = Get-Item $target -Force -EA SilentlyContinue
    if ($existing) {
        if ($existing.LinkTarget -eq $source) { Write-Host "linked  $target"; return }
        if (-not $canLink -and -not $existing.LinkTarget -and
            (Get-FileHash $target).Hash -eq (Get-FileHash $source).Hash) { Write-Host "same    $target"; return }
        $backup = "$target.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Move-Item $target $backup
        Write-Host "backup  $backup"
    }
    New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
    if ($canLink) {
        New-Item -ItemType SymbolicLink -Path $target -Target $source | Out-Null
        Write-Host "link    $target"
    } else {
        Copy-Item $source $target
        Write-Host "copy    $target"
    }
}

Install-Config 'shared\wezterm.lua'                     "$HOME\.config\wezterm\wezterm.lua"
Install-Config 'shared\gitconfig'                       "$HOME\.gitconfig"
Install-Config 'shared\git-ignore'                      "$HOME\.config\git\ignore"
Install-Config 'shared\ssh-config'                      "$HOME\.ssh\config"
Install-Config 'windows\profile.ps1'                    $PROFILE
Install-Config 'windows\powerlevel10k_classic.omp.json' "$HOME\.config\oh-my-posh\powerlevel10k_classic.omp.json"
Install-Config 'shared\claude\statusline.sh'            "$HOME\.claude\statusline.sh"

# A junction needs neither Developer Mode nor admin, so the mod and skill folders are always linked.
function Install-Folder($relative, $target) {
    $source = Join-Path $repo $relative
    $existing = Get-Item $target -Force -EA SilentlyContinue
    if ($existing -and $existing.LinkTarget -eq $source) { Write-Host "linked  $target"; return }
    if ($existing) {
        $backup = "$target.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Move-Item $target $backup
        Write-Host "backup  $backup"
    }
    New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
    New-Item -ItemType Junction -Path $target -Target $source | Out-Null
    Write-Host "link    $target"
}
Install-Folder 'shared\claude\mods\worklog'     "$HOME\.claude\mods\worklog"
Install-Folder 'shared\claude\skills\sessions'  "$HOME\.claude\skills\sessions"
Install-Folder 'shared\claude\skills\sync-day'  "$HOME\.claude\skills\sync-day"

# worklog-dash (the Alt+Shift+B dashboard tab) runs from this repo, and setup.ts asks for the
# per-machine values the repo leaves out: git identity, work log, PR sync, SSH host.
if (Get-Command bun -EA SilentlyContinue) {
    Push-Location (Join-Path $repo 'shared\worklog-dash')
    bun install --silent
    Pop-Location
    Write-Host "bun     installed worklog-dash dependencies"
    if ($Configure -or -not (Test-Path "$HOME\.config\dotfiles\local.json")) { bun (Join-Path $repo 'shared\setup.ts') }
} else {
    Write-Warning "No bun on PATH, so setup and the dashboard tab were skipped. Rerun without -SkipInstall to install it."
}

# settings.json also holds per-machine state (plugins, local paths), so merge
# in statusLine rather than linking the whole file. Full Git Bash path because
# a bare `bash` can resolve to WSL's.
$gitBash = Join-Path (Split-Path (Split-Path (Get-Command git).Source)) 'bin\bash.exe'
$statusLine = [ordered]@{
    type    = 'command'
    command = ("`"$gitBash`" `"$HOME\.claude\statusline.sh`"" -replace '\\', '/')
    padding = 0
}
$claudeSettings = "$HOME\.claude\settings.json"
$settings = if (Test-Path $claudeSettings) { Get-Content $claudeSettings -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
if (($settings.statusLine | ConvertTo-Json -Compress) -ne ($statusLine | ConvertTo-Json -Compress)) {
    $settings | Add-Member -Force -NotePropertyName statusLine -NotePropertyValue $statusLine
    $settings | ConvertTo-Json -Depth 20 | Set-Content $claudeSettings
    Write-Host "set     statusLine in $claudeSettings"
}

if (-not (Get-Module -ListAvailable PSFzf)) { Install-Module PSFzf -Scope CurrentUser -Force }

$fontDirs = "$env:LOCALAPPDATA\Microsoft\Windows\Fonts", "$env:WINDIR\Fonts"
if (-not (Get-ChildItem $fontDirs -Filter 'HackNerdFont-*' -EA SilentlyContinue)) { oh-my-posh font install Hack }

# The cache bakes in the theme path, so a stale one would keep the old prompt.
Remove-Item "$HOME\.cache\pwsh\init-cache.ps1" -EA SilentlyContinue

if (-not (Test-Path "$HOME\.ssh\id_ed25519")) {
    Write-Host "`nNo SSH key on this machine. Make one and authorize it on your SSH host:"
    Write-Host "  ssh-keygen -t ed25519"
    Write-Host "  Get-Content ~\.ssh\id_ed25519.pub | ssh <host> 'cat >> ~/.ssh/authorized_keys'"
}

Write-Host "`nDone. Restart WezTerm to pick up the font and config."
