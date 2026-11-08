# Dropping the ECS (`src/ecs.ts`)

> **This is phase 3 of [break-up-ext.md](break-up-ext.md).** It runs after that plan's phases 0–2, which move most of `Ext`'s logic into `src/core/` components. Its `extension.ts` line numbers refer to commit `cb2b205`, so by the time this plan runs, look the code up by name. Names follow the rules in break-up-ext.md: window state goes into `core/windows.ts` `Windows`, not into fields on `Ext`, and `grab_op.ts` will have become `core/grab.ts`. Phase 0 there doesn't remove `tiled_windows`/`Tags.Tiled`; step 3 below does.

## Context

The `dev-refactored` branch has been moving tree state out of side tables and into the tree itself: stacks live in leaves, forks link to `Fork` objects, and monitor/workspace sit on the root. What still uses the ECS falls into three groups:

1. **`Ext extends Ecs.System<ExtEvent>`** (`src/extension.ts:92`): Ext uses the World for window entities, 7 storages and tags, and the System for event dispatch (`register`/`run` via `GLibExecutor`).
2. **`Forest extends Ecs.World`** (`src/forest.ts:56`): one storage, `forks`, plus `create_entity`/`delete_entity` for fork ids.
3. **`Entity` as an id type**: about 200 references, in `node.ts`, `stack.ts`, `fork.ts`, `tiling.ts`, `grab_op.ts`, `window.ts` and `auto_tiler.ts`, using `entity_eq` to compare.

**Latent bug:** `World.create_entity` reuses the old tuple *object* and bumps its generation in place (`entity[1] += 1`). Anyone still holding a deleted window's `Entity` (for example `Forest.requested` keys, `workspace_active`, `Tiler.swap_window` or `was_attached_to`) ends up holding the *new* entity. So the generational check doesn't protect held references. Moving to never-reused ids fixes this along the way.

## Approach: window id = `meta.get_stable_sequence()`, fork id = the `Fork` object

Mutter never reuses stable sequences within a session. So `type WindowId = number` with `Map<WindowId, ShellWindow>` keeps the "lookup returns null once it's gone" behaviour at every `ext.windows.get(x)` call site, which is what the generations were for. It also keeps the diff mostly mechanical. Forks already carry their own object (commit 3cd36b5), so a fork can be identified by its `Fork` object.

Each step below is its own `ref:` commit that builds and runs.

### 1. Decouple the event executor from `System`
- `src/executor.ts`: `Executor<T>.wake(run: (e: T) => void, event)` instead of taking an `Ecs.System`.
- `Ext` owns a `GLibExecutor<ExtEvent>` field. `register(event)` becomes `this.executor.wake(e => this.run(e), event)`. Drop the `override` on `run`.
- Consider backing `GLibExecutor` with the `Scheduler` port from break-up-ext phase 1 (`core/scheduler.ts`), so event dispatch can be tested with `FakeScheduler`.

### 2. Move the per-window storages onto `ShellWindow`
In `src/extension.ts:199-219`:
- `names` → `ShellWindow.name` (set in its constructor). `window.ts:504` reads the field.
- `snapped` → `Windows.snapped: Set<WindowId>` (in `core/windows.ts`). `update_snapped` walks only the snapped windows, which costs O(snapped) where the old code paid O(capacity).
- `movements` → `Windows.movements: Map<WindowId, Rect>`. `is_empty()` becomes `size === 0`, which is O(1) where the old code scanned every slot. Don't replace it with a scan over windows.
- `window_signals` / `tilable_window_signals` → arrays on `ShellWindow`. Rewrite `clear_with`/`take_with` as plain loops.
- `ids` goes away: the id *is* the stable sequence, and `window_entity` (`extension.ts:2297`) becomes a `Map.get` instead of a linear `ids.find`.

### 3. Replace tags with fields
- `Floating`, `ForceTile`, `Blocked` → booleans on `ShellWindow` (they're set in `auto_tiler.ts:600-631`, `extension.ts:1897-1901`, `tiling.ts` and `window.ts:423`).
- `Tiled` is dead code. Only `tiling.ts:792` sets it (after a manual overlay move), and its only reader, `tiled_windows()` (`extension.ts:1929`), has no callers. Delete both.
- Delete `src/tags.ts`.

### 4. Switch window entities to `WindowId`
- `Windows` (`core/windows.ts`) owns the `Map<WindowId, ShellWindow>` and takes a `WindowSource` port, so it can be tested with fake windows. `Ext` keeps a forwarding `windows` getter until break-up-ext phase 4. `Storage.with(e, f)` becomes a `get` plus a null check (the 30 sites in extension.ts and about 40 elsewhere). `iter()` becomes `entries()`, and `values()` stays.
- `window_entity` creates the window under `meta.get_stable_sequence()`. `delete_entity(win)` (`extension.ts:832`, `1478`) becomes `windows.delete`, with signal and movement cleanup now on the object.
- Replace `import type { Entity }` with `WindowId` in `node.ts`, `stack.ts`, `tiling.ts`, `grab_op.ts`, `window.ts`, `auto_tiler.ts` and `forest.ts` (the window-typed parameters only). `Ecs.entity_eq(a, b)` becomes `a === b`, which also makes `Forest.requested: Map<…>` and `workspace_active` key correctly. With tuples they compared by identity, which only worked because of the in-place reuse above.
- Rename `ShellWindow.entity` to `id`, here or as a follow-up.

### 5. Make `Forest` a plain class with forks as objects
- `forks: Set<Fork>` (or `Fork[]`), no longer `extends Ecs.World`.
- Make `Fork.entity` go away: everything that passes a fork `Entity` (`detach(ext, fork_entity, …)`, `parent_of`, `fork_of`, `reassign_child_to_parent`, `reassign_children_to_parent`, the `[Entity, Fork]` tuple returns, and `record(win, parent, area)` callbacks in `fork.ts:216` and `node.ts:249`) passes the `Fork` itself. `Node.is_fork(e)` becomes `inner.fork === f`.
- `create_fork` becomes `new Fork(…)` plus `forks.add`. `delete_entity` becomes `delete_fork(f)`: `forks.delete(f); f.detached = true`.
- Callers in `auto_tiler.ts` (about 20 `forks.get` sites) and `extension.ts:2057,2225`.

### 6. Delete `src/ecs.ts`
Remove the remaining imports (`tiling.ts:14` has a commented-out one too).

## Implications

**Performance requirement:** the same or better at 10,000 windows, per operation, in big-O and without worse constants on hot paths. The rule: never trade an ECS O(1) for a scan.

| Operation | ECS now | After |
|---|---|---|
| Window lookup by id (`windows.get/with/contains`) | O(1): array index plus generation compare | O(1): `Map.get` on an int |
| Window id from `Meta.Window` (`window_entity`, every window signal) | **O(n)**: `ids.find` linear scan | O(1): `Map.get(stable_sequence)` |
| Has pending movements (`movements.is_empty`) | O(capacity) | O(1): `size` |
| Update snapped windows | O(capacity) | O(snapped) |
| Tag test or set | O(1): `Set` per entity | O(1): field |
| Iterate windows/forks | O(capacity) including dead slots, plus a tuple allocated per item | O(live), with no allocation for `values()` |
| `World.entities()` | **O(n · free)** | gone (its only user, `tiled_windows`, is dead) |
| Delete a window | O(storages) | O(1) `Map.delete` plus field cleanup |
| Fork lookup | O(1) `forks.get(entity)` | O(1): the caller already holds the `Fork` |
| Id comparison | two array derefs | `===` on an int |
| `parent_of` / `fork_of` | O(forks) | O(forks): **unchanged** |

Ids also stop being heap-allocated tuples. That means less GC pressure, which matters because GC pauses in gnome-shell are dropped compositor frames.

**What doesn't get better:** `parent_of`/`fork_of` (`forest.ts:73-91`) scan all forks. They come from this branch's "read it from the tree" design, not from the ECS, so this plan leaves them unchanged. At 10,000 windows they are the real bottleneck, and they go quadratic wherever they're called in a per-window loop. Fixing them is optional and separate from dropping the ECS (step 7 below).

**Behaviour:**
- Fixes the stale-`Entity` reuse bug described above.
- Iteration order of `windows` becomes insertion order instead of slot order (slots get reused). Anything that picks "the first matching window" could change on ties. It also becomes more deterministic.

**Cost:** a large mechanical diff, mostly in step 4, and further divergence from upstream pop-shell, which makes cherry-picking from it harder.

### 7. (Optional, separate) O(1) parent lookup
Keep a `parent: Fork | null` on each `Fork`, and a `Map<WindowId, Fork>` for leaves. Write both *only* inside the Forest's own mutation methods (`create_fork`, `delete_fork`, `reassign_*`, attach/detach, stack insert/remove). That way they can't drift from the tree. In a debug build, assert that they agree with a full scan after each mutation.

## Size and complexity

These estimates come from grep counts: about 490 non-ECS lines mention `entity`/`Entity`, of which roughly 93 use the `Entity` type, 31 use `entity_eq`, 15 use `with`/`take_with`/`get_or`/`clear_with`, 64 involve fork ids (`fork_entity`, `[Entity, Fork]`, `forks.get`), and 25 involve tags.

| Step | Lines touched | Net |
|---|---|---|
| 1 Executor | ~15 | ~0 |
| 2 Per-window storages | ~50 | ~−10 |
| 3 Tags | ~35 | ~−15 (`tags.ts` and dead `tiled_windows` removed) |
| 4 Window ids | ~200, mostly one line for one line | ~0 |
| 5 Forks as objects | ~120 | ~−30 (`[Entity, Fork]` tuples and `forks.get` lookups that can't fail go away) |
| 6 Delete `ecs.ts` | −293 | −293 |
| **Total for 1–6** | **~420 touched** | **about −350** |
| 7 Parent index (optional) | ~+80 including the debug assertion | +80 |

**Complexity, steps 1–6:** lower.
- **No inheritance chains:** `Ext extends System extends World` and `Forest extends World` go away. Ext and Forest become plain classes that own a few `Map`s and `Set`s.
- **Window state in one place:** today a window is a tuple, plus 7 parallel tables and a tag set on Ext. Afterwards, `ShellWindow` holds its own name, signals and flags. Only cross-cutting sets (pending movements, snapped windows) stay on Ext.
- **One identity per fork:** today a fork has both a `Fork` object and an `Entity`, so code passes `[Entity, Fork]` around and does `forks.get(e)` null checks that can't fail. Afterwards the fork is simply its object.
- **Plain types:** `Map<WindowId, ShellWindow>` and `===` replace the generic `Storage<T>`, `with`/`take_with` callbacks and `entity_eq`.
- **Same shape as today:** a window is still referred to by id and looked up, so "the window may be gone" null checks stay where they are now.
- **Less hidden behaviour:** in-place reuse of id tuples, and the generation semantics nobody relied on correctly, both disappear.

**Complexity, step 7:** higher. It adds bookkeeping that must stay in sync with the tree, which is the kind of state this branch has been removing. It's only worth doing if 10,000-window performance of `parent_of`/`fork_of` matters in practice. The debug assertion limits the risk.

## Order and size

Steps 1–3 are small and independent. Step 4 is the biggest but mechanical. Step 5 is a moderate change in forest.ts and auto_tiler.ts. Steps 4 and 5 can go in either order, though doing 4 first means step 5's signatures already use `WindowId`.

## Verification
- After each step: `make compile` (tsc), `make lint`, `make fmt-check`.
- Scaling check: write a small throwaway gjs script that runs the old `Storage`/`World` and the new Map/Set code side by side on 10,000 synthetic ids. Time lookups, finding a window's id from Mutter's window, the pending-movement check, iterating, and deleting then re-creating. The new code must be no slower on any of them.
- `make local-install`, then log out and back in (or a nested shell), and watch `journalctl -o cat -n 0 -f "$(which gnome-shell)"`.
- Go through the TESTING.md checklists with two monitors and the active hint on. After step 4, focus especially on: closing a window and immediately opening another, which is where the old entity reuse showed up; stacks/tabs (add, remove, dissolve); floating/force-tile toggles; snapping with tiling off; workspace and monitor moves; and the extension disable/enable cycle (signal cleanup).
