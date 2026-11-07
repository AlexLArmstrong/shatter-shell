import Clutter from 'gi://Clutter';
import Mtk from 'gi://Mtk';

import type { Entity } from './ecs.js';
import type { Ext } from './extension.js';
import type { Forest, MoveBy, MoveByCursor } from './forest.js';
import type { Fork } from './fork.js';
import type { ShellWindow } from './window.js';

import * as ecs from './ecs.js';
import * as geom from './geom.js';
import * as lib from './lib.js';
import * as node from './node.js';
import { Result, Ok, Err } from './result.js';
import { Stack } from './stack.js';
import * as tiling from './tiling.js';

const { NodeKind } = node;
import { Log } from './log.js';
import { Tags } from './tags.js';

/**
 * Which fork holds each tiled window. It's read from the tree rather than stored, so that it can never
 * disagree with it, and nothing needs to keep it up to date.
 */
export class Attachments {
    constructor(private readonly forest: Forest) {}

    /** The fork that holds the window's leaf, if it's tiled */
    get(window: Entity): Entity | null {
        return this.forest.fork_of(window);
    }

    /** Whether the window is tiled */
    contains(window: Entity): boolean {
        return this.get(window) !== null;
    }

    /** Every tiled window, with the fork that holds its leaf */
    iter(): Generator<[Entity, Entity], void> {
        return this.forest.tiled();
    }
}

export class AutoTiler {
    forest: Forest;
    readonly attached: Attachments;

    constructor(forest: Forest) {
        this.forest = forest;
        this.attached = new Attachments(forest);
    }

    /** Swap window associations in the auto-tiler
     *
     * Call this when a window has swapped positions with another, so that we
     * may update the associations in the auto-tiler world.
     */
    attach_swap(ext: Ext, a: Entity, b: Entity) {
        const a_ent = this.attached.get(a),
            b_ent = this.attached.get(b);

        let a_win = ext.windows.get(a),
            b_win = ext.windows.get(b);

        if (!a_ent || !b_ent || !a_win || !b_win) return;

        const a_fork = this.forest.forks.get(a_ent),
            b_fork = this.forest.forks.get(b_ent);

        if (!a_fork || !b_fork) return;

        if (ext.auto_tiler) {
            if (a_win.stack !== null) {
                const stack = ext.auto_tiler.forest.stacks.get(a_win.stack);
                if (stack) {
                    a = stack.active;
                    a_win = ext.windows.get(a);
                    if (!a_win) return;
                }
            }

            if (b_win.stack !== null) {
                const stack = ext.auto_tiler.forest.stacks.get(b_win.stack);
                if (stack) {
                    b = stack.active;
                    b_win = ext.windows.get(b);
                    if (!b_win) return;
                }
            }
        }

        const a_fn = a_fork.replace_window(ext, a_win, b_win);
        const b_fn = b_fork.replace_window(ext, b_win, a_win);

        if (a_fn) a_fn();
        if (b_fn) b_fn();

        a_win.show_now();
        b_win.show_now();

        this.tile(ext, a_fork, a_fork.area);
        this.tile(ext, b_fork, b_fork.area);
    }

    update_toplevel(ext: Ext, fork: Fork, monitor: MonitorID, smart_gaps: boolean) {
        const rect = ext.monitor_work_area(monitor);

        fork.smart_gapped = smart_gaps && fork.right === null;

        if (!fork.smart_gapped) {
            rect.x += ext.gap_outer;
            rect.y += ext.gap_outer;
            rect.width -= ext.gap_outer * 2;
            rect.height -= ext.gap_outer * 2;
        }

        const lone = fork.left.lone_window();
        if (lone) {
            const win = ext.windows.get(lone);
            if (win) {
                win.smart_gapped = fork.smart_gapped;
            }
        }

        fork.area = fork.set_area(rect.copy());
        fork.length_left = Math.round(fork.prev_ratio * fork.length());
        this.tile(ext, fork, fork.area);
    }

    /** Attaches `win` to an optionally-given monitor */
    attach_to_monitor(ext: Ext, win: ShellWindow, workspace_id: MonitorWorkspaceID, smart_gaps: boolean) {
        const rect = ext.monitor_work_area(workspace_id[0]);

        if (!smart_gaps) {
            rect.x += ext.gap_outer;
            rect.y += ext.gap_outer;
            rect.width -= ext.gap_outer * 2;
            rect.height -= ext.gap_outer * 2;
        }

        const [, fork] = this.forest.create_toplevel(win.entity, rect.copy(), workspace_id);
        this.forest.on_attach(win.entity);
        fork.smart_gapped = smart_gaps;
        win.smart_gapped = smart_gaps;

        this.tile(ext, fork, rect);
    }

    /** Tiles a window into another */
    attach_to_window(
        ext: Ext,
        attachee: ShellWindow,
        attacher: ShellWindow,
        move_by: MoveBy,
        stack_from_left: boolean = true,
    ): boolean {
        const attached = this.forest.attach_window(ext, attachee.entity, attacher.entity, move_by, stack_from_left);

        if (attached) {
            const [, fork] = attached;
            const monitor = ext.monitors.get(attachee.entity);
            if (monitor) {
                if (fork.is_toplevel && fork.smart_gapped && fork.right) {
                    fork.smart_gapped = false;
                    const rect = ext.monitor_work_area(fork.monitor);

                    rect.x += ext.gap_outer;
                    rect.y += ext.gap_outer;
                    rect.width -= ext.gap_outer * 2;
                    rect.height -= ext.gap_outer * 2;

                    fork.set_area(rect);
                }

                this.tile(ext, fork, fork.area.copy());
                return true;
            } else {
                Log.error(`missing monitor association for Window(${attachee.entity})`);
            }
        }

        return false;
    }

    /** Tile a window onto a workspace */
    attach_to_workspace(ext: Ext, win: ShellWindow, id: MonitorWorkspaceID) {
        if (ext.should_ignore_workspace(id[0])) {
            id = [id[0], 0];
        }

        const toplevel = this.forest.find_toplevel(id);

        if (toplevel) {
            const onto = this.forest.largest_window_on(ext, toplevel);
            if (onto) {
                if (this.attach_to_window(ext, onto, win, { auto: 0 })) {
                    return;
                }
            }
        }

        this.attach_to_monitor(ext, win, id, ext.settings.get_smart_gaps());
    }

    /** Automatically tiles a window into the window tree.
     *
     * ## Implementation Notes
     *
     * - First tries to tile onto the focused window
     * - Then tries to tile onto a monitor
     */
    auto_tile(ext: Ext, win: ShellWindow, ignore_focus: boolean = false) {
        const result = this.fetch_mode(ext, win, ignore_focus);
        this.detach_window(ext, win.entity);
        if (!result.ok) {
            Log.debug(`attach to workspace: ${result.why}`);
            this.attach_to_workspace(ext, win, ext.workspace_id(win));
        } else {
            Log.debug(`attaching to window ${win.entity}`);
            this.attach_to_window(ext, result.value, win, { auto: 0 });
        }
    }

    /** Destroy all widgets owned by this object. Call before dropping. */
    destroy(ext: Ext) {
        for (const [, [fent]] of this.forest.toplevel) {
            for (const node of this.forest.iter(fent)) {
                if (node.is_leaf()) {
                    for (const window of node.inner.entities) {
                        this.forest.on_detach(window);
                    }
                }
            }
        }

        // Forget the stacks before destroying them, so that their windows no longer find themselves in
        // one, and show again
        const stacks = Array.from(this.forest.stacks.values());
        this.forest.stacks.truncate(0);
        for (const stack of stacks) stack.destroy();

        ext.show_border_on_focused();
    }

    /**
     * Detaches the window from a tiling branch, if it is attached to one. Pass `untiling` as false when
     * the window is only being moved to another place in the tree, so that it keeps the position it
     * returns to once it's untiled.
     */
    detach_window(ext: Ext, win: Entity, untiling: boolean = true) {
        const prev_fork = this.attached.get(win);
        if (prev_fork) {
            const reflow_fork = this.forest.detach(ext, prev_fork, win, untiling);

            if (reflow_fork) {
                const fork = reflow_fork[1];
                if (fork.is_toplevel && ext.settings.get_smart_gaps() && fork.right === null) {
                    const rect = ext.monitor_work_area(fork.monitor);
                    fork.set_area(rect);
                    fork.smart_gapped = true;
                }

                this.tile(ext, fork, fork.area);
            }
        }
    }

    /** Swaps the location of two windows if the dropped window was dropped onto its sibling */
    dropped_on_sibling(ext: Ext, win: Entity, swap: boolean = true): boolean {
        const fork_entity = this.attached.get(win);

        if (fork_entity) {
            const cursor = lib.cursor_rect();
            const fork = this.forest.forks.get(fork_entity);

            if (fork) {
                const left = fork.left.lone_window();
                const right = fork.right?.lone_window() ?? null;

                if (left && right && fork.right) {
                    const sibling = ext.windows.get(ecs.entity_eq(left, win) ? right : left);
                    if (sibling && (ecs.entity_eq(left, win) || ecs.entity_eq(right, win))) {
                        if (sibling.rect().contains_rect(cursor)) {
                            if (swap) {
                                // Both are leaves of one window without tabs, so swapping the leaves
                                // swaps the windows
                                const temp = fork.left;
                                fork.left = fork.right;
                                fork.right = temp;

                                this.tile(ext, fork, fork.area);
                            }

                            return true;
                        }
                    }
                }
            }
        }

        return false;
    }

    find_stack(entity: Entity): [Fork, node.Node<node.NodeStack>, boolean] | null {
        const att = this.attached.get(entity);
        if (att) {
            const fork = this.forest.forks.get(att);
            if (fork) {
                if (fork.left.is_in_stack(entity)) {
                    return [fork, fork.left, true];
                } else if (fork.right && fork.right.is_in_stack(entity)) {
                    return [fork, fork.right, false];
                }
            }
        }

        return null;
    }

    /** Find the fork that belongs to a window */
    get_parent_fork(window: Entity): Fork | null {
        const entity = this.attached.get(window);
        if (entity === null) return null;

        const fork = this.forest.forks.get(entity);

        return fork;
    }

    largest_on_workspace(ext: Ext, monitor: MonitorID, workspace: WorkspaceID): ShellWindow | null {
        const workspace_id: MonitorWorkspaceID = [monitor, workspace];
        const toplevel = this.forest.find_toplevel(workspace_id);
        if (toplevel) {
            return this.forest.largest_window_on(ext, toplevel);
        }

        return null;
    }

    /** Performed when a window that has been dropped is destined to be tiled
     *
     * ## Implementation Notes
     *
     * - If the window is dropped onto a window, tile onto it
     * - If no window is present, tile onto the monitor
     */
    on_drop(ext: Ext, win: ShellWindow, via_overview: boolean = false) {
        const [cursor, monitor] = ext.cursor_status();
        const workspace = ext.active_workspace();

        if (win.rect().contains_rect(cursor)) {
            via_overview = false;
        }

        const attach_mon = () => {
            const attach_to = this.largest_on_workspace(ext, monitor, workspace);
            if (attach_to) {
                this.attach_to_window(ext, attach_to, win, { auto: 0 });
            } else {
                this.attach_to_monitor(ext, win, [monitor, workspace], ext.settings.get_smart_gaps());
            }
        };

        if (via_overview) {
            this.detach_window(ext, win.entity);
            attach_mon();
            return;
        }

        let attach_to = null;
        for (const found of ext.windows_at_pointer(cursor, monitor, workspace)) {
            if (found != win && this.attached.contains(found.entity)) {
                attach_to = found;
                break;
            }
        }

        const fork = this.get_parent_fork(win.entity);
        if (!fork) return;

        const windowless = this.largest_on_workspace(ext, monitor, workspace) === null;

        // If it appears to not be attaching to anything, assume we are attaching to its sibling
        if (attach_to === null) {
            const left = fork.left.lone_window();
            const right = fork.right?.lone_window() ?? null;
            if (left && right) {
                const attaching = ecs.entity_eq(left, win.entity) ? right : left;
                attach_to = ext.windows.get(attaching);
            } else if (!windowless) {
                this.tile(ext, fork, fork.area);
            }
        }

        if (windowless) {
            this.detach_window(ext, win.entity);
            this.attach_to_monitor(ext, win, [monitor, workspace], ext.settings.get_smart_gaps());
        } else if (attach_to) {
            this.place_or_stack(ext, win, attach_to, cursor);
        } else {
            this.detach_window(ext, win.entity);
            attach_mon();
        }
    }

    place_or_stack(ext: Ext, win: ShellWindow, attach_to: ShellWindow, cursor: Mtk.Rectangle): boolean {
        const fork = this.get_parent_fork(attach_to.entity);
        if (!fork) return true;

        const is_sibling = this.windows_are_siblings(win.entity, attach_to.entity);

        const attach_area: Mtk.Rectangle =
            (win.stack === null && attach_to.stack === null && is_sibling) || (win.stack === null && is_sibling)
                ? fork.area
                : attach_to.meta.get_frame_rect();

        let placement: MoveBy | null = cursor_placement(ext, attach_area, cursor);
        const stack = ext.auto_tiler?.find_stack(attach_to.entity);

        const matching_stack = win.stack !== null && win.stack === attach_to.stack;
        const { Left, Up, Right, Down } = tiling.Direction;

        const swap = (o: Clutter.Orientation, d: tiling.Direction) => {
            fork.set_orientation(o);
            const is_left = fork.left.is_window(win.entity);
            const swap = (is_left && (d == Right || d == Down)) || (!is_left && (d == Left || d == Up));

            if (swap) {
                fork.swap_branches();
            }

            this.tile(ext, fork, fork.area);
        };

        if (placement) {
            const direction =
                placement.orientation === Clutter.Orientation.HORIZONTAL
                    ? placement.swap
                        ? Left
                        : Right
                    : placement.swap
                      ? Up
                      : Down;

            if (stack) {
                if (matching_stack) {
                    ext.tiler.move_from_stack(ext, stack, win, direction, true);
                    return true;
                } else if (attach_to.stack !== null) {
                    const onto_stack = ext.auto_tiler?.find_stack(attach_to.entity);
                    if (onto_stack) {
                        if (is_sibling && win.stack === null) {
                            swap(placement.orientation, direction);
                            return true;
                        } else {
                            ext.tiler.move_alongside_stack(ext, onto_stack, win, direction);
                        }

                        return true;
                    }
                }
            } else if (is_sibling && win.stack === null) {
                swap(placement.orientation, direction);
                return true;
            } else if (fork.is_toplevel && fork.right === null) {
                this.detach_window(ext, win.entity);
                this.attach_to_window(ext, attach_to, win, placement);
                swap(placement.orientation, direction);
                return true;
            }
        } else if (matching_stack) {
            this.tile(ext, fork, fork.area);
            return true;
        } else {
            if (attach_to.stack === null) this.create_stack(ext, attach_to);

            placement = { auto: 0 };
        }

        this.detach_window(ext, win.entity);
        return this.attach_to_window(ext, attach_to, win, placement);
    }

    /** Schedules a fork to be reflowed */
    reflow(ext: Ext, win: Entity) {
        const fork_entity = this.attached.get(win);
        if (!fork_entity) return;

        ext.register_fn(() => {
            const fork = this.forest.forks.get(fork_entity);
            if (fork) this.tile(ext, fork, fork.area);
        });
    }

    tile(ext: Ext, fork: Fork, area: Mtk.Rectangle) {
        this.forest.tile(ext, fork, area);
    }

    toggle_floating(ext: Ext) {
        const focused = ext.get_focused_window();
        if (!focused) return;

        if (focused.was_tilable) {
            ext.delete_tag(focused.entity, Tags.ForceTile);
            const fork_entity = this.attached.get(focused.entity);
            if (fork_entity) {
                this.detach_window(ext, focused.entity);
            }
            ext.add_tag(focused.entity, Tags.Floating);
        } else {
            ext.delete_tag(focused.entity, Tags.Floating);
            ext.add_tag(focused.entity, Tags.ForceTile);
            this.auto_tile(ext, focused, false);
        }
        focused.reconsider_tiling();

        ext.register_fn(() => focused.request_activate(true));
    }

    toggle_orientation(ext: Ext, window: ShellWindow) {
        const result = this.toggle_orientation_(ext, window);
        if (!result.ok) {
            Log.warn(`toggle_orientation: ${result.why}`);
        }
    }

    toggle_stacking(ext: Ext, window?: ShellWindow) {
        const focused = window ?? ext.get_focused_window();
        if (!focused) return;

        // Disable floating if floating is enabled
        if (ext.contains_tag(focused.entity, Tags.Floating)) {
            ext.delete_tag(focused.entity, Tags.Floating);
            this.auto_tile(ext, focused, false);
        }

        const fork_entity = this.attached.get(focused.entity);

        if (fork_entity) {
            const fork = this.forest.forks.get(fork_entity);
            if (fork) {
                this.unstack(ext, fork, focused, true);
            }
        }
    }

    unstack(ext: Ext, fork: Fork, win: ShellWindow, toggled: boolean = false) {
        if (toggled && fork.left.is_window(win.entity)) {
            this.add_tabs(ext, fork, fork.left);
            fork.measure(this.forest, ext, fork.area, this.forest.on_record());
        } else if (fork.left.is_in_stack(win.entity)) {
            // Only a stack of one window loses its tabs
            if (fork.left.inner.entities.length === 1) {
                this.remove_tabs(fork.left);
                fork.measure(this.forest, ext, fork.area, this.forest.on_record());
                if (!fork.right) this.forest.reassign_to_parent(fork, fork.left);
            }
        } else if (toggled && fork.right && fork.right.is_window(win.entity)) {
            this.add_tabs(ext, fork, fork.right);
            fork.measure(this.forest, ext, fork.area, this.forest.on_record());
        } else if (fork.right && fork.right.is_in_stack(win.entity)) {
            if (fork.right.inner.entities.length === 1) {
                this.remove_tabs(fork.right);
                fork.measure(this.forest, ext, fork.area, this.forest.on_record());
            }
        }

        this.tile(ext, fork, fork.area);
    }

    /** Gives a leaf tabs, along with the Stack that draws them, so that it can hold more windows */
    private add_tabs(ext: Ext, fork: Fork, leaf: node.Node<node.NodeStack>) {
        if (leaf.inner.tabbed) return;

        leaf.inner.tabbed = true;
        leaf.inner.idx = this.forest.stacks.insert(new Stack(ext, leaf.inner, fork.workspace));
    }

    /** Takes the tabs from a leaf of one window, which releases the window */
    private remove_tabs(leaf: node.Node<node.NodeStack>) {
        if (leaf.inner.idx !== null) this.forest.stacks.remove(leaf.inner.idx)?.destroy();

        leaf.inner.tabbed = false;
        leaf.inner.idx = null;
    }

    /** Gives the leaf of a window tabs, if it has none yet */
    create_stack(ext: Ext, window: ShellWindow) {
        const entity = this.attached.get(window.entity);
        if (!entity) return;

        const fork = this.forest.forks.get(entity);
        if (!fork) return;

        const leaf = fork.left.is_window(window.entity)
            ? fork.left
            : fork.right?.is_window(window.entity)
              ? fork.right
              : null;
        if (!leaf) return;

        this.add_tabs(ext, fork, leaf);
        fork.measure(this.forest, ext, fork.area, this.forest.on_record());
    }

    /** Draws a stack again from the tree, and places its tab bar if it has been measured */
    update_stack(_ext: Ext, stack: node.NodeStack) {
        const container = this.forest.view_of(stack);
        if (!container) return;

        // Only what differs from the last time is changed, so a retile leaves the windows as they are
        container.sync();
        if (stack.rect) container.update_positions(stack.rect);
    }

    windows_are_siblings(a: Entity, b: Entity): Entity | null {
        const a_parent = this.attached.get(a);
        const b_parent = this.attached.get(b);

        if (a_parent !== null && null !== b_parent && ecs.entity_eq(a_parent, b_parent)) {
            return a_parent;
        }

        return null;
    }

    private fetch_mode(ext: Ext, win: ShellWindow, ignore_focus: boolean = false): Result<ShellWindow, string> {
        if (ignore_focus) {
            return Err('ignoring focus');
        }

        const prev = ext.previously_focused(win);

        if (!prev) {
            return Err('no window has been previously focused');
        }

        const onto = ext.windows.get(prev);

        if (!onto) {
            return Err('no focus window');
        }

        if (ecs.entity_eq(onto.entity, win.entity)) {
            return Err('tiled window and attach window are the same window');
        }

        if (!onto.is_tilable()) {
            return Err('focused window is not tilable');
        }

        if (onto.meta.minimized) {
            return Err('previous window was minimized');
        }

        if (!this.attached.contains(onto.entity)) {
            return Err('focused window is not attached');
        }

        return onto.monitor_id() == win.monitor_id() && onto.workspace_id() == win.workspace_id()
            ? Ok(onto)
            : Err('window is not on the same monitor or workspace');
    }

    private toggle_orientation_(ext: Ext, focused: ShellWindow): Result<void, string> {
        if (focused.is_maximized()) {
            return Err('cannot toggle maximized window');
        }

        const fork_entity = this.attached.get(focused.entity);
        if (!fork_entity) {
            return Err(`window is not attached to the tree`);
        }

        const fork = this.forest.forks.get(fork_entity);
        if (!fork) {
            return Err("window's fork attachment does not exist");
        }

        if (!fork.right) return Ok(void 0);

        fork.toggle_orientation();
        this.forest.measure(ext, fork, fork.area);

        for (const child of this.forest.iter(fork_entity)) {
            if (child.inner.kind != NodeKind.FORK) continue;

            const child_fork = child.inner.fork;
            if (!child_fork.detached) {
                child_fork.rebalance_orientation();
                this.forest.measure(ext, child_fork, child_fork.area);
            } else {
                Log.error(
                    `toggle_orientation: Fork(${child_fork.entity}) does not exist to have its orientation toggled`,
                );
            }
        }

        this.forest.arrange(ext, fork.workspace, true);

        return Ok(void 0);
    }
}

/** Enables deriving the orientation that a window will be attached by the mouse position.
 *
 * A null indicates that the window should be stacked
 */
export function cursor_placement(ext: Ext, area: Mtk.Rectangle, cursor: Mtk.Rectangle): MoveByCursor | null {
    const { LEFT, RIGHT, TOP, BOTTOM } = geom.Side;
    const { HORIZONTAL, VERTICAL } = Clutter.Orientation;

    const [, side] = geom.nearest_side(ext, [cursor.x, cursor.y], area);

    const res: [Clutter.Orientation, boolean] | null =
        side === LEFT
            ? [HORIZONTAL, true]
            : side === RIGHT
              ? [HORIZONTAL, false]
              : side === TOP
                ? [VERTICAL, true]
                : side === BOTTOM
                  ? [VERTICAL, false]
                  : null;

    return res ? { orientation: res[0], swap: res[1] } : null;
}
