Push-Location

. .\test\include\util.ps1

$local, $remote = Make-Local-Remote-Repos $PWD

# configure vscode settings
Write-VSCode-Settings $local  @{
    "hg.useBookmarks"      = $false;
    "hg.autoUpdate"        = $true; 
    "hg.autoInOutInterval" = 10;
}

# write file, branch, commit, push --> remote
Set-Location $local
Set-Content abcd.txt "Hello world"
hg add abcd.txt
hg branch "oak" | out-null
hg ci -m "Initial commit"
hg push -b oak -f | out-null
Set-Content abcd.txt "Greetings world"
hg ci -m "Local commit #1"

# in remote: update to branch, change file, commit
Set-Location $remote
hg update "oak" | out-null
Set-Content abcd.txt "Goodbye world"
hg ci -m "Remote commit #1"
Set-Content abcd.txt "Farewell world"
hg ci -m "Remote commit #2"

Write-Host
Write-Host "In $($local):" 
Write-Host "Expect 2 incoming/1 outgoing changesets for branch 'oak'" -ForegroundColor Green
Write-Host "Pull + autoUpdate should succeed, but merge required between branches" -ForegroundColor Green

Pop-Location
