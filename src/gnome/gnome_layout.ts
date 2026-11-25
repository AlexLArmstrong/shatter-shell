import Meta from 'gi://Meta';

import type { Fork } from '../core/fork.js';
import type { Movement } from '../core/movement.js';
import type { Layout } from '../core/node.js';
import type { Ext } from '../extension.js';
import type { Forest } from '../forest.js';
import type { MutterWindowHandle } from './mutter_window_handle.js';

import { copy_rect, type Rect } from '../core/geom.js';
import { NodeKind } from '../core/node.js';
import { Log } from '../log.js';
import { TAB_HEIGHT_UNSCALED } from '../stack.js';

/**
 * The GNOME side of the tree: it lays the trees out with the extension's sizes, moves the windows to
 * where the tree puts them, and moves trees to other monitors.
 */
export class GnomeLayout {
    constructor(private readonly ext: Ext) {}

    /** The layout of `forest`'s trees, with the extension's sizes, and whether the user is moving a window */
    layout(forest: Forest): Layout {
        const { ext } = this;
        return forest.layout({
            gap_inner: ext.sizes.gap_inner,
            gap_inner_half: ext.sizes.gap_inner_half,
            tab_height: () => ext.sizes.scale * TAB_HEIGHT_UNSCALED,
            manually_moved: () => ext.grab.window !== null || ext.gnome_tiling_mode.resizing_window,
            minimum_size: window => ext.windows.get(window)?.minimum_size() ?? [0, 0],
        });
    }

    /** Works out where the windows of the tree from `fork` go, in `area` */
    measure(forest: Forest, fork: Fork, area: Rect) {
        fork.measure(this.layout(forest), area);
    }

    /** Lays out the tree from `fork` in `area`, and moves its windows there */
    tile(forest: Forest, fork: Fork, area: Rect) {
        this.measure(forest, fork, area);
        this.arrange(forest);
    }

    /** Resizes the tree around a window that the user resized by `movement` to `rect` */
    resize(forest: Forest, fork: Fork, window: WindowId, movement: Movement, rect: Rect) {
        forest.resize(this.layout(forest), fork, window, movement, rect);
    }

    /** Moves every window to where the tree put it, and places the tab bars that need it */
    arrange(forest: Forest) {
        const { ext } = this;
        for (const [window_id, r] of forest.requested) {
            const window = ext.windows.get(window_id);
            if (!window) continue;

            let on_complete = () => {
                if (!window.actor_exists()) return;
            };

            if (ext.gnome_tiling_mode.window !== null) {
                if (ext.gnome_tiling_mode.window === window_id) {
                    on_complete = () => {
                        ext.set_overlay(window.frame());

                        if (!window.actor_exists()) return;
                    };
                }
            }

            this.move(window, r.rect, on_complete);
        }

        forest.requested.clear();

        for (const [stack] of forest.stack_updates.splice(0)) {
            ext.gnome_forest?.update_stack(stack);
        }
    }

    /** Moves a tree to another monitor and workspace, and lays it out in `area` there */
    migrate(forest: Forest, fork: Fork, area: Rect, monitor: MonitorID, workspace: WorkspaceID) {
        const { ext } = this;
        if (ext.gnome_forest && fork.is_root) {
            const primary = global.display.get_primary_monitor() === monitor;

            fork.monitor = monitor;
            fork.workspace = workspace;
            fork.on_primary_display = primary;

            const blocked = [];

            for (const child of forest.iter(fork)) {
                switch (child.inner.kind) {
                    case NodeKind.FORK:
                        // Its monitor and workspace are the tree's, which have already changed
                        break;
                    case NodeKind.STACK:
                        for (const window_id of child.inner.windows) {
                            const window = ext.windows.get(window_id);

                            if (window) {
                                ext.size_signals_block(window);
                                window.reassignment = false;
                                window.meta.change_workspace_by_index(workspace, true);
                                blocked.push(window);
                            }
                        }
                }
            }

            area.x = Math.trunc(area.x + ext.sizes.gap_outer);
            area.y = Math.trunc(area.y + ext.sizes.gap_outer);
            area.width = Math.trunc(area.width - ext.sizes.gap_outer * 2);
            area.height = Math.trunc(area.height - ext.sizes.gap_outer * 2);

            fork.set_area(copy_rect(area));
            fork.measure(this.layout(forest), area);
            this.arrange(forest);

            for (const window of blocked) {
                ext.size_signals_unblock(window);
            }
        }
    }

    /** Moves a window, ignoring the size changes that this makes */
    private move(window: MutterWindowHandle, rect: Rect, on_complete: () => void) {
        const { ext } = this;
        if (!(window.meta instanceof Meta.Window)) {
            Log.error(`attempting to move a window in a tree which lacks a Meta.Window`);
            return;
        }

        const actor = window.meta.get_compositor_private<Meta.WindowActor | null>();

        if (!actor) {
            Log.warn(`Window(${window.id}) does not have an actor, and therefore cannot be moved`);
            return;
        }

        ext.size_signals_block(window);
        window.move(rect, () => {
            on_complete();
            ext.size_signals_unblock(window);
        });
    }
}
