
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