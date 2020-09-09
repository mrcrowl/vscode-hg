# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [2.0.4](https://github.com/vivekvjn/vscode-hg/compare/v2.0.2...v2.0.4) (2020-09-09)


### Bug Fixes

* assign correct encoding type ([8d34695](https://github.com/vivekvjn/vscode-hg/commit/8d34695dcaac3eae7e9bef2a20dbdce03eaa2b37))

### [2.0.3](https://github.com/vivekvjn/vscode-hg/compare/v2.0.2...v2.0.3) (2020-09-09)

## [2.0.1]

### Bug fix

- fix deprecated call to allocate Buffer()

## [2.0.0]

### What's New

- Upgraded VSCode Engine to 1.40.0

### Bug fix

- fix: correctly open conflicted files, diff view on click [#35](https://github.com/mrcrowl/vscode-hg/issues/35)

## [1.3.0]

### Bug fix

- Fixed bug caused by API change in vscode v1.31 [#65](https://github.com/mrcrowl/vscode-hg/issues/65)

## [1.2.2-3]

### Bug fix

- Fixed slow multi-file Hg operations (such as stage/add file)

### What's New

- Added "multi-root ready" keyword, as requested by VS Code Team [#29](https://github.com/mrcrowl/vscode-hg/issues/29)

## [1.2.1]

### Bug fix

- Restored missing gutter indicators that were lost in v1.2.0 [#31](https://github.com/mrcrowl/vscode-hg/issues/31)

## [1.2.0]

### What's New

- Support for multiple source control providers. Hg should now play nicely alongside Git and other source control providers [#29]((https://github.com/mrcrowl/vscode-hg/issues/29), [#26](https://github.com/mrcrowl/vscode-hg/issues/26), [#24](https://github.com/mrcrowl/vscode-hg/issues/24)
- Support for multiple folder workspaces (insiders) [#29](https://github.com/mrcrowl/vscode-hg/issues/29)

### Bug fix

- Fixed missing commands from window title area (open file/open changes)

## [1.1.7]

### Bug fix

- Fixed missing commands from command palette (due to extension authoring changes in vscode 1.16)

## [1.1.5]

### Bug fixes

- Changeset descriptions were being truncated at the first colon in "Hg: Log" and "Hg: View File History..." commands [#20](https://github.com/mrcrowl/vscode-hg/issues/20)
- Fixed conflict with blackbox logging extension [thanks @ajansveld][#14](https://github.com/mrcrowl/vscode-hg/issues/14)

## [1.1.3]

### What's New

- [Bookmarks](https://www.mercurial-scm.org/wiki/Bookmarks) support

  - You can now choose between named-branches or bookmarks.
  - Set `"hg.useBookmarks": true` for bookmarks.
  - New supporting commands:
    - Set Bookmark
    - Remove Bookmark
  - Also affects: update / push / pull / autoInOut
  - See [#10](https://github.com/mrcrowl/vscode-hg/issues/10) for complete details.

- Auto update after pull: `hg.autoUpdate` [#15](https://github.com/mrcrowl/vscode-hg/issues/15)
  - On by default

Shoutout to [ajansveld](https://github.com/ajansveld) for the ideas and help with testing these new features.

### Changes to settings

- The new `hg.autoUpdate` setting is on by default.
- New setting `hg.pushPullScope` replaces `hg.pushPullBranch` (which is now deprecated) but remains for backwards compatibility. Using `hg.pushPullScope` affects both named-branches and bookmarks modes.

## [1.0.7]

### What's New

- Faster commits. The outgoing/incoming check is now separate from the commit.
- New setting `hg.pushPullBranch` controls which branch(es) will be pushed/pulled [#8](https://github.com/mrcrowl/vscode-hg/issues/8)
  - `all`: all branches (this is the default)
  - `current`: only the current branch
  - `default`: only the default branch
- `hg.autoInOut` setting and status-bar display respects `hg.pushPullBranch`
- Spinning icon while pushing/pulling.

## [1.0.5-6]

### What's New

- Improvements to commandMode `server` reliability.
- Marketplace category change --> SCM Providers [PR #5]

## [1.0.4]

### What's New

- If you have staged files when you rollback a commit, then all files from the rolled-back commit become staged too.
- Attempt to fix issue with non-ascii commit messages encoding. [Issue #4](https://github.com/mrcrowl/vscode-hg/issues/4)

### Change to defaults

- Default HGENCODING is now utf-8, unless an existing environment variable exists.

## [1.0.3]

### What's New

- The context menu commands "Open Changes" and "Open File" now work with multiple selections in source control.
- These commands are also available in each group-level context menu (e.g. Changes or Staged Changes).

### Change to defaults

- `cli` is now the default commandMode. Although `server` is faster, it occasionally causes hangs.
- I will attempt to track down the cause of the hangs before reverting this change.
- In the meantime, if you prefer `server`, you'll need to add a user-setting.

### Bug Fixes

- When using Undo/Rollback to undo a commit, the last commit message is properly restored.

## [1.0.2]

### What's New

- A commit including missing files now prompts for these to be deleted before committing.
- With `hg.autoInOut` enabled, the status is shown as a tick when there are no incoming/outgoing changesets.
- With `hg.autoInOut` enabled, the status bar tooltip shows when the next check time will be.
- Problems with push/pull operations now show an error indicator on the status bar.

### Bug Fixes

- Rollback/Undo now updates the count of outgoing commits immediately.
- When you attempt to pull with no default path configured, the option to 'Open hgrc' now works from the error prompt.
- With `hg.autoInOut` disabled, the incoming count is no longer shown after you commit.
