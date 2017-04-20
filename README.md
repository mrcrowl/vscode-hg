# Overview

Fast, integrated Mercurial source control, using the new VS Code SCM API.

> **Note**: This extension will leverage your 
> machine's Mercurial (hg) installation, 
> so you need to [install Mercurial](https://www.mercurial-scm.org) first. 

# Features

 * Add files and commit from the source control side-bar (i.e. where git normally appears).

 * All the basics: commit, add, forget,  update, push and pull. 

 * See changes inline within text editor. 

 * History (log) and diff.

 * Branch, merge heads, merge with branch, resolve + unresolve files.

 * Quickly switch branches, push and pull via status bar.

 * Automatic incoming/outgoing counters. 

 * Undo/rollback

 * Two command modes:
    * `cmdline`: spawns a new hg process per command
    * `server`: keeps an hg serve --cmdserve running (default, 10x faster)

# Getting Started

## Switch to Hg

1. Open the source control side-bar.<br><br>
   ![Switch to Hg](images/switch-to-hg.gif)

 1. Click **⋯** > _Switch SCM Provider..._

 1. Choose _Hg_

## Initialize a new repo

 * Just click the Mercurial icon from the source control title area:<br><br>
   ![Switch to Hg](images/init.gif) 

## Clone a repo