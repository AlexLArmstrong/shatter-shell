# Break up `Ext`: from a 2,532-line god object to a composition root with testable parts

## Context

`src/extension.ts` is 2,532 lines, about 2,300 of them in the `Ext` class. `Ext` is really the global state. It holds the ECS world, the event dispatcher, ~40 fields, the signal wiring, monitor hotplug, workspace events, grab/resize, the window lifecycle, focus history, gaps, theme and the floating-exceptions picker. Eight other modules receive the whole thing as `ext: Ext` (`tiling.ts` uses it 99 times, `auto_tiler.ts` 56). Nothing is unit-tested, and almost nothing can be: only `workspace_events.ts` loads outside gnome-shell. Even `rectangle.ts` imports `gi://Mtk` at runtime.

Splitting the file into `fn(ext: Ext, …)` modules is rejected: it keeps the global-state coupling.

## Naming rules

1. **One term per concept**, using GNOME's own word and what the code already says:
   - **monitor**, never "display" (`MonitorID`, `monitor_work_area`). The `displays` field and the `Display` interface get renamed.
   - **grab**, never "drag" (mutter's `grab-op-*`, `GrabOp`, `on_grab_start`).
   - **overlay** for the drop preview (the existing `overlay` actor and `set_overlay`).
   - **floating exception** for the exceptions feature (`floating_exceptions/`, `add_app_exception`).
2. **Class names are plain nouns, without role suffixes** (no Tracker/Watcher/Controller/Registry/Bag/Manager): `Gaps`, `Monitors`, `Grab`, `FocusHistory`.
3. **A file is named after the snake_case of its main export**: `Monitors` lives in `monitors.ts`. One name, one place, never the same file name in two directories.
4. **Interfaces (ports) are named for what they provide. Implementations are prefixed with the library behind them**, following the existing `Executor` → `GLibExecutor` pattern: `Scheduler` → `GLibScheduler`, `MonitorSource` → `MutterMonitorSource`, `StylesheetLoader` → `StStylesheetLoader`.
5. Methods and fields stay snake_case, like the rest of the codebase.

## End goal

1. **`extension.ts` is only a composition root (~250 lines).** `enable()` builds the adapters and the components, gives each component only the ports it needs, and wires signals to them. `disable()` tears them down.
2. **`src/core/` holds the components and their logic, written against ports.** No runtime `gi://`/`resource://` imports and no `global`. Geometry uses a structural `Rect = { x, y, width, height }` (which `Mtk.Rectangle` satisfies). Because the dependencies are interfaces, the stateful components themselves are pure, so everything in `core/` can be tested against fakes. There's no separate "pure helpers" layer with names that duplicate the components'.
3. **`src/gnome/` holds the adapters,** the only new code that touches mutter/GLib/St. They're thin and untested, and only implement ports. Where an existing class already fits a port structurally (`ExtensionSettings` provides `GapSettings` and `ThemeSettings`), no adapter is needed.

| `core/` file | Class | Takes over from `Ext` | Ports it takes |
|---|---|---|---|
| `scheduler.ts` | `Scheduler` (interface) + `FakeScheduler` for tests | `timeouts` and its `GLib.timeout_add`/`idle_add` calls | — |
| `signals.ts` | `Signals` | `signals`, `connect_object`, the disconnect loop | `SignalSource` |
| `theme.ts` | `Theme` | `current_style`, `reload_theme`, `on_gnome_theme_changed` | `ThemeSettings`, `StylesheetLoader` |
| `gaps.ts` | `Gaps` | `gap_*`, `column_size`, `row_size`, `dpi`, `set_gap_*`, `on_gap_*`, `update_scale` | `GapSettings` |
| `focus_history.ts` | `FocusHistory<Id>` | `prev_focused`, `workspace_active`, `previously_focused`, the bookkeeping in `on_focused`/`on_destroy` | — |
| `monitors.ts` | `Monitors` | `displays`, `displays_updating`, `workareas_update`, `ignore_display_update`, `update_display_configuration`, `find_unused_workspace` | `MonitorSource`, `Scheduler`, `TreeMigrator` |
| `grab.ts` (absorbs `grab_op.ts`) | `Grab` | `grab_op`, `drag_signal`, `moved_by_mouse`, `on_grab_start/end`, `movement_is_valid`, overlay area computation | `Scheduler`, `Overlay`, `TileQuery` |
| `workspaces.ts` | `Workspaces` | `workspace_changes`, `on_workspace_added/removed/changed`, `schedule_workspace_changes`, `restack` | `Scheduler`, `TileQuery` |
| `workspace_events.ts` | (moved as is) | — | — |
| `floating_exceptions.ts` | `FloatingExceptions` | `exception_selecting`, `exception_add/dialog/select`, `reload_and_reapply_tiling_config` | `Config`, `WindowPicker`, `Scheduler` |
| `settings_actions.ts` | `actions_for(key)` | the 40-line settings-key `switch` in `signals_attach`, as a table | — |
| `windows.ts` (drop-ecs) | `Windows` | `windows`, per-window signals, `movements`, `snapped`, `window_entity` | `WindowSource` |

| `gnome/` file | Implements |
|---|---|
| `glib_scheduler.ts` | `Scheduler` |
| `mutter_monitor_source.ts` | `MonitorSource` |
| `st_stylesheet_loader.ts` | `StylesheetLoader` (today's `load_theme`) |
| `gobject_signal_source.ts` | `SignalSource` |
| `shell_window_picker.ts` | `WindowPicker` (overview + gjs dialog process) |

The `Overlay`, `TileQuery` and `TreeMigrator` ports are implemented by the existing `St.BoxLayout` overlay and by `AutoTiler`/`Fork` respectively. They are shaped from the calls those components actually make.

4. **Tests:** `node:test` + `node:assert`, in `tests/*.test.ts`. `tests/tsconfig.json` (extends the root one, `types: ["node"]`, output in `target-test/`) keeps Node's types out of the extension's build and the compiled tests out of `_build`. The only new dependency is `@types/node`. `make test` compiles and runs them, and so does CI. In `src/core/**`, an oxlint `no-restricted-imports` override bans runtime imports of `gi://*`, `resource://*` and `../*`, but allows type-only ones. *(Done in the `focus-history` PR.)*
5. **Other modules depend on ports, not `Ext`.** This comes later, gradually. Until then `Ext` keeps one-line forwarding getters (`get gap_inner() { return this.gaps.inner }`), so `tiling.ts`, `auto_tiler.ts` and the rest don't change in the same commits.

**Performance (10k-window rule):** every operation keeps its big-O. `FocusHistory` is O(1), except for `forget`, which is O(workspaces) per destroyed window because it also clears the per-workspace entries. Migration planning stays O(toplevels × changed monitors). No lookup becomes a scan. Components are built once, so nothing is allocated on hot paths.

## Phases (`ref:` commits; each one builds and passes `make test`)

**Upstream first step (branch `focus-history`, based on `origin/master_resolute`):** the test harness, CI, the `src/core/` lint override, and `core/focus_history.ts` `FocusHistory` with tests. It also fixes destroyed windows staying recorded as a workspace's last focused one. The phases below assume it has been merged and `dev-refactored` rebased onto it.

**Phase 0: groundwork.** Move `workspace_events.ts` → `core/` and give it its first tests. Delete dead code: `actor_of`, `monitor_area`, `find_monitor_to_retach`, `size_changed_block/unblock` (plus the `size_changed_signal` field), `is_floating`, `update_display_configuration_before`. Rename `displays`/`Display` → `monitors`/`MonitorInfo`.

**Phase 1: leaf components with no ports, or only trivial ones.** `Scheduler` (+ `GLibScheduler`), `Gaps`, `Theme` (+ `StStylesheetLoader`), `settings_actions`. Each comes with tests written against today's behaviour before `Ext` switches over to it.

**Phase 2: the bigger components.** `Signals`, `Monitors` (+ `MutterMonitorSource`), `Grab`, `Workspaces`, `FloatingExceptions` (+ `ShellWindowPicker`). `signals_attach` becomes each component's `attach(signals)` plus the root's wiring. The module-global `indicator` becomes a constructor argument. After this, `extension.ts` is ~600 lines.

**Phase 3: [drop-ecs.md](drop-ecs.md).** `Ext` stops being an `Ecs.System`, and the window storages become `core/windows.ts` `Windows`. `extension.ts` reaches ~250 lines. That plan has been aligned with this one; its line numbers refer to `cb2b205`.

**Phase 4: narrow the other modules, one at a time.** Swap `ext: Ext` for ports and delete the forwarding getters. Start with `focus.ts`, `node.ts` and `fork.ts`, and leave `tiling.ts` and `auto_tiler.ts` for last.

Ids: `FocusHistory<Id>` and the other core classes are generic and compare with `===`, so phase 3's `Entity` → `WindowId` switch doesn't touch `core/`. Today's `prev_focused` already compares with `!==`, so behaviour stays the same.

## Git
Work in a worktree off `dev-refactored`. Prefix commits with `ref:`, authored as AlexLArmstrong, with no Claude trailers. Push to `fork` with `~/.ssh/alex.pub` + IdentitiesOnly. Implement phases 0–1 first, then stop for review.

## Verification
- Every commit: `make compile`, `make lint`, `make fmt-check`, `make test`.
- Write each component's tests from the current code before `Ext` delegates to it. Then check the delegation commit with `git diff --color-moved=dimmed-zebra`.
- Smoke test in a nested shell (`make debug` + `make listen`), following TESTING.md: theme switching; gap and tab settings; grab overlay and drop; mouse resize, including a click on a resize edge without moving; minimize and unminimize back into a stack or fork; closing a window in a stack; adding and removing workspaces; adding and removing a virtual monitor; the floating-exceptions picker; toggling auto-tiling; lock/unlock and disable/enable without duplicate handlers.
