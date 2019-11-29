Push-Location

. .\test\include\util.ps1

$local, $remote = Make-Local-Remote-Repos $PWD

# configure vscode settings
Write-VSCode-Settings $local  @{
    "hg.useBookmarks"      = $true;
    "hg.autoUpdate"        = $true;
    "hg.autoInOutInterval" = 10;
}

# write file, bookmark, commit, push --> remote
Set-Location $local
Set-Content abcd.txt "Hello world"
hg add abcd.txt
hg book "hobbit"
hg ci -m "Initial commit"
hg push -B hobbit | out-null

# in remote: update, activate bookmark, change file, commit
Set-Location $remote
hg update | out-null
hg book hobbit
Set-Content abcd.txt "Goodbye world"
hg ci -m "Remote commit #1"

# in local: pull <-- remote
Set-Location $local
hg pull | out-null

# in remote: commit 2 x changes
Set-Location $remote
Set-Content abcd.txt "Greetings world"
hg ci -m "Remote commit #2"
Set-Content abcd.txt "Farewell world"
hg ci -m "Remote commit #3"
hg update 0 | out-null
hg bookmark "lotr"
Set-Content frodo.txt "Frodo was here"
hg add frodo.txt
hg ci -m "Remote commit #4 (lotr bookmark)" | out-null

# in local: check incoming changes for branch
Set-Location $local
$incoming = hg incoming -B -q
$secondIncoming = $incoming.Split('\n')[1]
$match = $secondIncoming -match '\s*(\S*)\s*(\S*)'
$hash = $matches[2]
hg incoming -q -r $hash

Set-Location $local
hg update 0 | out-null
hg bookmark "lotr"

Write-Host
Write-Host "Expect 1 incoming changeset for $local on bookmark 'lotr'" -ForegroundColor Green
Write-Host "After pull frodo.txt should appear." -ForegroundColor Green

Pop-Location
