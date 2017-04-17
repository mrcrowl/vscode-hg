
# Overview

Integrated Mercurial source control, using the new VS Code SCM API.

# Features

 * Init new repo or clone from URL.
 
 * Basic commands: commit, add, forget, discard changes.

 * Emulated staging of files to commit.

 * Basic file history (log) and diff.

 * Merge heads, merge with branch, resolve + unresolve files.

 * Switch branches, push and pull via status bar.

 * Create new branch.

 * Automatic incoming/outgoing watcher

 * Undo/rollback

 * Two command modes:
    * `cmdline`: spawns a new hg process per command
    * `server`: keeps an hg serve --cmdserve running (default, 10x faster)


