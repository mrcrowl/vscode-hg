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

# in remote: update to branch, change file, commit
Set-Location $remote
hg update "oak" | out-null
Set-Content abcd.txt "Goodbye world"
hg ci -m "Remote commit #1"
Set-Content abcd.txt "Farewell world"
hg ci -m "Remote commit #2"

Write-Host
Write-Host "Expect 1 incoming changesets for $local on branch 'okay'" -ForegroundColor Green
Write-Host "After pull abcd.txt should contain 'Farewell world'" -ForegroundColor Green

Pop-Location
