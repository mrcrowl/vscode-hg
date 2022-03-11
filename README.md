# Overview

### Integrated Mercurial source control

# Prerequisites

> **Note**: This extension leverages your
> machine's Mercurial (hg) installation,  
> so you need to [install Mercurial](https://www.mercurial-scm.org) first.

---

![Hg](images/hg.png)

# Features

-   Add files and commit from the source control side-bar (i.e. where git normally appears).

-   All the basics: commit, add, forget, update, push and pull.

-   See changes inline within text editor.

-   Interactive log for basic file history and diff.

-   Branch, merge heads, merge with branch, resolve + unresolve files.

-   Quickly switch branches, push and pull via status bar.

-   Supports named-branches or bookmark workflows.

-   Automatic incoming/outgoing counters.

-   Undo/rollback.

-   Shelve/Unshelve support.

-   Purge support.

-   Rebase support.

-   Show annotation for current line or for whole file

# Feedback & Contributing

-   Please report any bugs, suggestions or documentation requests via the [Github issues](https://github.com/mrcrowl/vscode-hg/issues) (_yes_, I see the irony).
-   Feel free to submit [pull requests](https://github.com/mrcrowl/vscode-hg/pulls).

## Initialize a new repo

![Init a repo](images/init.gif)

-   Just click the Mercurial icon from the source control title area:

## Update to a branch/tag/bookmark

![Change branches](images/change-branch.gif)

-   The current branch name is shown in the bottom-left corner.
-   Click it to see a list of branches and tags that you can update to.
-   When `hg.useBookmarks` is enabled, this changes to bookmarks.

# Settings

`hg.enabled { boolean }`

-   Enables Hg as a source control manager in VS Code.

`hg.useBookmarks { boolean }`

-   Choose between [bookmarks](https://www.mercurial-scm.org/wiki/Bookmarks) vs. [named-branches](https://www.mercurial-scm.org/wiki/NamedBranches):  
    `"false"` — named-branches mode (default)  
    `"true"` — bookmarks mode

`hg.pushPullScope { all | current | default }`

-   Specifies what to include in Push/Pull operations.
-   Depends on the choice of `hg.useBookmarks`.
-   For named-branches mode: &nbsp; (i.e. `hg.useBookmarks` = false)  
    `"all"` &mdash; all branches / unrestricted (this is the default)  
    `"current"` &mdash; only includes changesets for the current branch  
    `"default"` &mdash; only includes changesets for the _default_ branch
-   For bookmarks mode: &nbsp; (i.e. `hg.useBookmarks` = true)  
    `"all"` &mdash; all bookmarks / unrestricted (this is the default)  
    `"current"` &mdash; only includes changesets for the active bookmark  
    `"default"` &mdash; only includes changesets for bookmarks on the _default_ branch

`hg.pushPullBranch` _**DEPRECATED**_ `{ all | current | default }`

-   Use `hg.pushPullScope` instead.
-   Specifies which branch(es) should be included in Push/Pull operations.
-   Included only for backwards compatibility.

`hg.autoUpdate { boolean }`

-   Enables automatic update of working directory to branch/bookmark head after pulling (equivalent to `hg pull --update`)  
    `"true"` &mdash; enabled  
    `"false"` &mdash; disabled, manual update/merge required

`hg.autoInOut { boolean }`

-   Enables automatic counting of incoming/outgoing changes.
-   When enabled, these show in the status bar.
-   Updated every 3 minutes, or whenever a commit/push/pull is done.
-   Note: when `hg.pushPullBranch` is set to `"current"` or `"default"` then only the respective branch will be included in the counts.

`hg.autoRefresh { boolean }`

-   Enables automatic refreshing of Source Control tab and badge counter when files within the project change:  
    `"true"` &mdash; enabled  
    `"false"` &mdash; disabled, manual refresh still available.

`hg.countBadge { tracked | all | off }`

-   Controls the badge counter for Source Control in the activity bar:  
    `"tracked"` &mdash; only count changes to tracked files (default).  
    `"all"` &mdash; include untracked files in count.  
    `"off"` &mdash; no badge counter.

`hg.allowPushNewBranches { boolean }`

-   Overrides the warning that normally occurs when a new branch is pushed:  
    `"true"` &mdash; new branches are pushed without warning (default).  
    `"false"` &mdash; shows a prompt when new branches are being pushed (e.g `hg push --new-branch`)

`hg.path { string | null }`

-   Specifies an explicit `hg` file path to use.
-   This should only be used if `hg` cannot be found automatically.
-   The default behaviour is to search for `hg` in commonly-known install locations and on the PATH.

`hg.commandMode`

-   Controls the method used to communicate with `hg`.
-   There is a slight start-up performance cost with repeatedly running `hg` commands.
-   Running a [command server](https://www.mercurial-scm.org/wiki/CommandServer) process in the background allows frequently-used commands to run ~10× faster (e.g. `cat`, `status`, `summary`, `branch` etc.)
-   The server feature is still expiremental, and is therefore not the default.
    `"cli"` &mdash; spawn a new `hg` process per command (default).
    `"server"` &mdash; run a command server process &nbsp;_i.e. `hg serve --cmdserve`_

`hg.lineAnnotationEnabled`

-   Enables `hg annotate` decorations at end of the currently selected lines

# Acknowledgements

[ajansveld](https://github.com/ajansveld), [hoffmael](https://github.com/hoffmael), [nioh-wiki](https://github.com/nioh-wiki), [joaomoreno](https://github.com/joaomoreno), [nsgundy](https://github.com/nsgundy)
