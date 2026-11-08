# Testing

This document provides a guideline for testing and verifying the expected behaviors of the project. When a patch is ready for testing, the checklists may be copied and marked as they are proven to be working.

## Logs

To begin watching logs, open a terminal with the following command:

```
journalctl -o cat -n 0 -f "$(which gnome-shell)" | grep -v warning
```

Note that because the logs are from GNOME Shell, there will be messages from all installed extensions, and GNOME Shell itself. Shatter Shell is fairly chatty though, so the majority of the logs should be from Shatter Shell. Shatter Shell logs are usually prepended with `shatter-shell:`, but sometimes GNOME has internal errors and warnings surrounding those logs that could be useful for pointing to an issue that we can resolve in Shatter Shell.

## Checklists

Tasks for a tester to verify when approving a patch. Use complex window layouts and at least two displays. Turn on active hint during testing.

## With tiling enabled

### Tiling

- [ ] Super direction keys changes focus in the correct direction
- [ ] Windows moved with the keyboard tile into place
- [ ] Windows moved with the mouse tile into place
- [ ] Windows swap with the keyboard (test with different size windows)
- [ ] Windows can be resized with the keyboard (Test resizing four windows above, below, right, and left to ensure shortcut consistency)
- [ ] Windows can be resized with the mouse
- [ ] Minimizing a window detaches it from the tree and re-tiles remaining windows
- [ ] Unminimizing a window re-tiles the window
- [ ] Maximizing with the keyboard (`Super` `M`) covers tiled windows
- [ ] Unmaximizing with keyboard (`Super` `M`) re-tiles into place
- [ ] Maximizing with the mouse covers tiled windows
- [ ] Unmaximizing with mouse re-tiles into place
- [ ] Full-screening removes the active hint and full-screens on one display
- [ ] Unfull-screening adds the active hint and re-tiles into place
- [ ] The active hint is drawn right above the focused window, at once: a dialog of the window or an always-on-top window covers it, and it's in place straight after raising the window or moving it to another workspace.
- [ ] Maximizing a YouTube video fills the screen and unmaximizing retiles the browser in place
- [ ] VIM shortcuts work as direction keys
- [ ] `Super` `O` changes window orientation
- [ ] `Super` `G` floats and then re-tiles a window
- [ ] With "Reset untiled window's position" enabled, a window that was moved into or out of a stack, onto another window or to another workspace still returns to where it was before it was first tiled when it's floated.
- [ ] Float a window with `Super` `G`. It should be movable and resizeable in window management mode with keyboard keys
- [ ] `Super` `Q` Closes a window
- [ ] Turn off auto-tiling. New windows launch floating.
- [ ] Turn on auto-tiling. Windows automatically tile.
- [ ] Disabling and enabling auto-tiling correctly handles minimized, maximized, fullscreen, floating, and non-floating windows (This test needs a better definition, steps, or to be separated out.)

### Stacking

- [ ] Windows can be moved into a stack.
- [ ] Windows can be moved out of a stack.
- [ ] Windows inside and outside of a stack can be swapped multiple times and in both directions.
- [ ] Closing the active tab returns to the tab that was active before it, and swapping the active tab with a window outside the stack makes that window the active tab.
- [ ] Moving a tab left or right with the keyboard keeps it active, and moving it past either end takes it out of the stack.
- [ ] Swapping a stacked window, moving a tab, or a new window joining a stack never shows two of the stack's windows at once, not even for a frame.
- [ ] Moving the last window out of a stack works as expected.
- [ ] A stack dissolves into a plain window when closing, moving or dragging away its second-last window, and focus stays on the remaining window after a close.
- [ ] Toggling stacking on a lone window still gives it a tab bar, so that other windows can be moved into it.
- [ ] Quickly switching tabs and then closing or moving one never leaves a window that only appears in the overview and workspace animations.
- [ ] Moving the last window off a workspace, or removing a workspace, never leaves another workspace's window drawn on the current one, where it can be seen but not used. Check by entering an empty workspace afterwards.
- [ ] A hidden tab that is moved to another workspace, or whose stack is destroyed while on another workspace, shows when that workspace is entered.
- [ ] After removing or inserting a workspace before a stack, switching to the stack's workspace shows only its active tab, and the tab bar only shows there.
- [ ] Switching back and forth between workspaces with stacks never shows a stack's inactive tabs, and the tab bars are in place once the switch has finished.
- [ ] Stacks can be resized with the keyboard.
- [ ] Stacks can be resized with the mouse.
- [ ] Only the tab bar of the stack with the focused window looks focused.
- [ ] Changing the tab bar height and gap in the preferences, or the corner radii and tab margins with gsettings, updates existing stacks immediately.
- [ ] Changing the size unit with gsettings resizes the gaps and the tab bars immediately.
- [ ] By default, the tab bar's corners match those of libadwaita windows (15 pixels), and the tabs' corners are 12 pixels, whatever the size unit.
- [ ] With no top and bottom margin, tabs fill the height of the tab bar. With a margin, they're centered.
- [ ] The space between two tabs is the same as the space at either end of the tab bar.
- [ ] Lock and unlock the screen-- stacks should still exist and windows should not have moved.
- [ ] Full-screen an application within the stack, then quit the application-- the remaining tabs should be visible.

### Workspaces

- [ ] Removing a workspace in the middle, and reordering workspaces by dragging them in the overview, keeps the windows of every other workspace tiled together, and new windows on any of them tile with that workspace's windows. Check with static workspaces too.
- [ ] Removing a workspace with tiled windows moves them into the tiling of the workspace that GNOME moves them to. If that workspace had no tiled windows on that monitor, they keep their layout.
- [ ] Dropping a window between two workspaces in the overview, which creates a workspace there, keeps the layout of every workspace after it, and tiles the dropped window on its own in the new one. Try it with the window taken from the workspace just before the drop, and from one after it.
- [ ] Moving one window of a tiled workspace to another with the keyboard, the mouse or the window menu leaves the other windows tiled where they are.
- [ ] Windows can be moved to another workspace with the keyboard
- [ ] Windows can be moved to another workspace with the mouse
- [ ] Windows can be moved to workspaces between existing workspaces
- [ ] Moving windows to another workspace re-tiled the previous and new workspace
- [ ] Active hint is present on the new workspace and once the window is returned to its previous workspace
- [ ] Floating windows move across workspaces
- [ ] Remove windows from the 2nd worspace in a 3 workspace setup. The 3rd workspace becomes the 2nd workspace, and tiling is unaffected by the move.

### Displays

- [ ] Windows move across displays in adjustment mode with direction keys
- [ ] Windows move across displays with the mouse
- [ ] A tiled window that is maximized and then moved to another display leaves its tiling there, and a floating window dropped on another display stays floating.
- [ ] Dragging a window onto another tiled window, after removing or reordering workspaces, still tiles it with the window under the pointer.
- [ ] Changing the primary display moves the top bar. Window heights adjust on all monitors for the new position.
- [ ] Unplug a display - windows from the display retile on a new workspace on the remaining display
- [ ] Unplug a display - windows that were already on the remaining display stay on their workspaces, and stacks keep their tabs
- [ ] Plug an additional display into a laptop - windows and workspaces don't changes
- [ ] NOTE: Add vertical monitor layout test

### Floating Exceptions

- [ ] Add a window to floating exceptions-- it should float immediately.
- [ ] Close and re-open the window-- it should float when opened.
- [ ] Add an app to floating exceptions-- it should float immediately.
- [ ] Close and re-open the app-- it should float when opened.

## With Tiling Disabled

### Tiling

- [ ] Super direction keys changes focus in the correct direction
- [ ] Windows can be moved with the keyboard
- [ ] Windows can be moved with the mouse
- [ ] Windows swap with the keyboard (test with different size windows)
- [ ] Windows can be resized with the keyboard
- [ ] Windows can be resized with the mouse
- [ ] Windows can be half-tiled left and right with `Ctrl``Super``left`/`right`

### Displays

- [ ] Windows move across displays in adjustment mode with directions keys
- [ ] Windows move across displays with the mouse

### Miscellaneous

- [ ] Close all windows-- no icons should be active in the GNOME launcher.
- [ ] Open a window, enable tiling, stack the window, move to a different workspace, and disable tiling. The window should not become visible on the empty workspace.
- [ ] With tiling still disabled, minimize the single window. The active hint should go away.
- [ ] Maximize a window, then open another app with the Activities overview. The newly-opened app should be visible and focused.
