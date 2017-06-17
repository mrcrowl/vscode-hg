
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

Push-Location

$sandbox = "$PWD\test\sandbox"
Make-Directory $sandbox
Empty-Directory $sandbox

$local = Init-Repo "$sandbox\local"
$remote = Init-Repo "$sandbox\remote"

# configure vscode settings
Make-Directory "$local\.vscode"
Set-Content "$local\.vscode\settings.json" @"
{
    "hg.useBookmarks": true,
    "hg.autoInOutInterval": 10000
}
"@

# connect local --> remote
Set-Location $local
Set-Content .hg\hgrc @"
[paths]
default = ../remote
"@

# write file, bookmark, commit, push --> remote
Set-Content abcd.txt "Hello world"
hg add abcd.txt
hg book "hobbit"
hg ci -m "Initial commit"
hg push -B hobbit > null

# in remote: update, activate bookmark, change file, commit
Set-Location $remote
hg update > null
hg book hobbit
Set-Content abcd.txt "Goodbye world"
hg ci -m "Remote commit #1"

# in local: pull <-- remote
Set-Location $local
hg pull > null

# in remote: commit 2 x changes
Set-Location $remote
Set-Content abcd.txt "Greetings world"
hg ci -m "Remote commit #2"
Set-Content abcd.txt "Farewell world"
hg ci -m "Remote commit #3"
hg update 0 > null
hg bookmark "lotr"
Set-Content frodo.txt "Frodo was here"
hg add frodo.txt
hg ci -m "Remote commit #4 (lotr bookmark)" > null

# in local: check incoming changes for branch
Set-Location $local
$incoming = hg incoming -B -q
$firstIncoming = $incoming.Split('\n')[0]
$match = $firstIncoming -match '\s*(\S*)\s*(\S*)'
$hash = $matches[2]
hg incoming -q -r $hash

Pop-Location
