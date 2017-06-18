$ErrorActionPreference = "Stop"

function Empty-Directory([string] $path)
{
    $_ = Remove-Item "$path\*" -Recurse
}

function Make-Directory([string] $path)
{
    if (-not (Test-Path $path -Type container))
    {
        $_ = New-Item $path -Type directory 
    }
}

function Init-Repo([string] $path)
{
    Push-Location

    Make-Directory $path
    cd $path
    hg init

    Pop-Location
    return $path
}

function Make-Local-Remote-Repos(
    [Parameter()]
    [ValidateNotNullOrEmpty()] 
    [string] $root= $(throw "Make-Local-Remote-Repos() -- `$root is mandatory"))
{
    $sandbox = "$root\test\sandbox"
    Make-Directory $sandbox
    Empty-Directory $sandbox

    $local = Init-Repo "$sandbox\local"
    $remote = Init-Repo "$sandbox\remote"

    # connect local --> remote
    Set-Content "$local\.hg\hgrc" @"
[paths]
default = ../remote
"@

    return $local, $remote
}

function Write-VSCode-Settings([string] $workspace, $settings)
{
    Make-Directory "$workspace\.vscode"
    $settingsJSON = $settings | ConvertTo-Json
    Set-Content "$workspace\.vscode\settings.json" $settingsJSON
}