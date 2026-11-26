import type { Misc } from '@girs/gnome-shell';
import type GObject from 'gi://GObject';

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type { Grab, Target } from '../core/grab.js';
import type { EdgeSide, Movement } from '../core/movement.js';
import type { Signals } from '../core/signals.js';
import type { Ext } from '../extension.js';
import type { MutterWindowHandle } from './mutter_window_handle.js';

import * as geom from '../core/geom.js';
import { GrabKind } from '../core/grab.js';
import { movement_is_valid } from '../core/movement.js';
import * as Ecs from '../ecs.js';
import * as lib from '../lib.js';
import { Log } from '../log.js';
import * as stack from '../stack.js';

const { overview } = Main;

/** Connects GNOME's grabs of windows to {@link Grab}, and carries out what it decides */
export class GnomeGrab {
    private preview_timer: SignalID | null = null;

    /** The window whose size signals the grab blocked */
    private blocked: MutterWindowHandle | null = null;

    constructor(
        private readonly ext: Ext,
        private readonly grab: Grab,
    ) {}

    attach(signals: Signals<GObject.Object | Misc.signals.EventEmitter>) {
        const { ext } = this;
        const display = global.display;

        signals.connect_with(display, () =>
            display.connect('grab-op-begin', (_display, win, op) => {
                this.started(win, op);
            }),
        );

        signals.connect_with(display, () =>
            display.connect('grab-op-end', (_display, win, op) => {
                ext.register_fn(() => this.ended(win, op));
            }),
        );

        signals.connect_with(overview, () =>
            overview.connect('window-drag-begin', (_, win) => {
                this.started(win);
            }),
        );

        signals.connect_with(overview, () =>
            overview.connect('window-drag-end', (_, win) => {
                ext.register_fn(() => this.ended(win));
            }),
        );

        signals.connect_with(overview, () =>
            overview.connect('window-drag-cancelled', () => {
                this.cancel();
            }),
        );
    }

    cancel() {
        const { ext } = this;

        if (this.preview_timer !== null) {
            ext.overlay.visible = false;
            GLib.source_remove(this.preview_timer);
            this.preview_timer = null;
        }

        if (this.blocked !== null) {
            ext.size_signals_unblock(this.blocked);
            this.blocked = null;
        }

        this.grab.cancel();
    }

    private ended(meta: Meta.Window, op?: number) {
        const win = this.ext.get_window(meta);

        if (win !== null) {
            win.grab = false;
        }

        if (win !== null && win.is_tilable()) this.drop(win, op);

        this.cancel();
    }

    private drop(win: MutterWindowHandle, op?: number) {
        const { ext } = this;
        const at = ext.gnome_forest;

        ext.size_signals_unblock(win);

        const pointer = lib.cursor_rect();
        const kind = kind_of(op);

        const monitor = ext.placement(win)[0];

        const outcome = this.grab.end(win, {
            kind,
            minimized: win.meta.minimized,
            maximized: win.is_maximized(),
            auto_tiling: at !== null,
            in_tree: win.leaf !== null,
            other_monitor: monitor !== win.monitor_id(),
            pointer_in_work_area: win.meta.get_work_area_for_monitor(monitor).contains_rect(pointer),
            pointer: [pointer.x, pointer.y],
            snap_to_grid: ext.settings.get_snap_to_grid(),
        });

        switch (outcome.kind) {
            case 'none':
                break;
            case 'not_grabbed':
                Log.error(`grabbed entity is not the same as the one that was dropped`);
                break;
            case 'minimized':
                ext.on_minimize(win);
                break;
            case 'reflow':
                at?.reflow(win.entity);
                break;
            case 'drop':
                at?.on_drop(win, outcome.other_monitor);
                break;
            case 'resize':
                this.resize(win, outcome.movement);
                break;
            case 'snap':
                ext.gnome_tiling_mode.snap(win);
                break;
        }
    }

    private resize(win: MutterWindowHandle, movement: Movement) {
        const { ext } = this;
        const at = ext.gnome_forest;
        if (!at) return;

        const fork_entity = win.leaf?.parent?.entity ?? null;
        if (!fork_entity) {
            Log.error(`no fork entity found`);
            return;
        }

        const forest = at.forest;
        const fork = forest.forks.get(fork_entity);
        if (!fork) {
            Log.error(`no fork component found`);
            return;
        }

        const crect = win.frame();
        if (win.stack != null) {
            const tab_dimension = ext.sizes.scale * stack.TAB_HEIGHT_UNSCALED;
            crect.height += tab_dimension;
            crect.y -= tab_dimension;
        }

        const tree = forest.find_tree(ext.workspace_id());
        if (tree) {
            geom.clamp(crect, tree.root.area);
        }

        const neighbour_rect = (side: EdgeSide) => ext.focus_selector.toward(ext, side, win)?.frame() ?? null;
        if (movement_is_valid(movement, win.frame(), neighbour_rect)) {
            forest.resize(ext, fork_entity, fork, win.entity, movement, crect);
            forest.arrange(ext);
        } else {
            forest.tile(ext, fork, fork.area);
        }
    }

    private started(meta: Meta.Window | null, op?: number) {
        if (!meta) return;

        const { ext } = this;
        const win = ext.get_window(meta);
        if (!win) return;

        win.grab = true;
        if (!win.is_tilable()) return;

        this.cancel();

        const preview = this.grab.start(win, kind_of(op), overview.visible);

        ext.size_signals_block(win);
        this.blocked = win;

        if (!preview) return;

        const workspace = ext.active_workspace();
        this.preview_timer = GLib.timeout_add(GLib.PRIORITY_LOW, 200, () => this.preview(win, workspace));
    }

    private preview(win: MutterWindowHandle, workspace: WorkspaceID): boolean {
        const { ext } = this;
        ext.overlay.visible = false;

        const at = ext.gnome_forest;
        if (!at || !this.grab.holds(win)) {
            this.preview_timer = null;
            return GLib.SOURCE_REMOVE;
        }

        const [cursor, monitor] = ext.cursor_status();

        // The tiled window under the pointer, or else the window's sibling in its fork
        let attach_to: MutterWindowHandle | null = null;
        for (const found of ext.windows_at_pointer(cursor, monitor, workspace)) {
            if (found !== win && found.leaf !== null) {
                attach_to = found;
                break;
            }
        }

        const fork = at.get_parent_fork(win.entity);
        if (!fork) return GLib.SOURCE_CONTINUE;

        if (attach_to === null) {
            const left = fork.left.lone_window();
            const right = fork.right?.lone_window() ?? null;
            if (left && right) {
                attach_to = Ecs.entity_eq(left.entity, win.entity) ? right : left;
            }
        }

        let empty_area = null;
        if (at.largest_on_workspace(monitor, workspace) === null) {
            empty_area = ext.monitor_work_area(monitor);
            empty_area.x += ext.sizes.gap_outer;
            empty_area.y += ext.sizes.gap_outer;
            empty_area.width -= ext.sizes.gap_outer * 2;
            empty_area.height -= ext.sizes.gap_outer * 2;
        }

        const target: Target | null = attach_to && {
            frame: attach_to.meta.get_frame_rect(),
            sibling: at.windows_are_siblings(win.entity, attach_to.entity) !== null,
            fork_area: fork.area,
            in_stack: win.stack !== null,
        };

        const area = this.grab.overlay_for(
            [cursor.x, cursor.y],
            empty_area,
            target,
            ext.settings.get_stacking_with_mouse(),
        );

        if (area) {
            ext.set_overlay(area);
            ext.overlay.visible = true;
        }

        return GLib.SOURCE_CONTINUE;
    }
}

/** An overview drag has no grab op. A keyboard resize counts as a resize. */
function kind_of(op: number | undefined): GrabKind {
    if (op === undefined) return GrabKind.OverviewDrag;
    if (lib.is_resize_op(op)) return GrabKind.Resize;
    return lib.is_keyboard_op(op) ? GrabKind.KeyboardMove : GrabKind.MouseMove;
}
