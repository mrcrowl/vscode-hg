
**v1.0.4**
=============================================

## What's New
  - Changed extension category to 'SCM Providers'. [PR#5](https://github.com/mrcrowl/vscode-hg/pull/5)

**v1.0.3**
=============================================

## What's New
  - The context menu commands "Open Changes" and "Open File" now work with multiple selections in source control.
  - These commands are also available in each group-level context menu (e.g. Changes or Staged Changes).

## Change to defaults
  - `cli` is now the default commandMode.  Although `server` is faster, it occasionally causes hangs.
  - I will attempt to track down the cause of the hangs before reverting this change.
  - In the meantime, if you prefer `server`, you'll need to add a user-setting.

## Bug Fixes
  - When using Undo/Rollback to undo a commit, the last commit message is properly restored.

**v1.0.2**
=============================================

## What's New
  - A commit including missing files now prompts for these to be deleted before committing.
  - With `autoInOut` enabled, the status is shown as a tick when there are no incoming/outgoing changesets.
  - With `autoInOut` enabled, the status bar tooltip shows when the next check time will be.
  - Problems with push/pull operations now show an error indicator on the status bar.

## Bug Fixes
  - Rollback/Undo now updates the count of outgoing commits immediately.
  - When you attempt to pull with no default path configured, the option to 'Open hgrc' now works from the error prompt. 
  - With `autoInOut` disabled, the incoming count is no longer shown after you commit.