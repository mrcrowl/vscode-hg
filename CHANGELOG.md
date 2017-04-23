
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