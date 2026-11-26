import Clutter from 'gi://Clutter';
import Mtk from 'gi://Mtk';

import type { Entity } from '../ecs.js';
import type { Ext } from '../extension.js';
import type { Forest, MoveBy, MoveByCursor } from '../forest.js';
import type { Fork } from '../fork.js';
import type { MutterWindowHandle } from './mutter_window_handle.js';

import * as geom from '../core/geom.js';
import * as ecs from '../ecs.js';
import * as lib from '../lib.js';
import * as node from '../node.js';
import { Result, Ok, Err } from '../result.js';
import { Stack } from '../stack.js';
import * as tiling from './gnome_tiling_mode.js';

const { NodeKind } = node;
import { Log } from '../log.js';
import { Tags } from '../tags.js';

/** Which fork holds each tiled window */
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

/** The GNOME side of the Forest: tiles windows into its trees and lays them out, while auto-tiling is on */
export class GnomeForest {
    forest: Forest;
    readonly attached: Attachments;

    constructor(
        private readonly ext: Ext,
        forest: Forest,
    ) {
        this.forest = forest;
        this.attached = new Attachments(forest);
    }

    /** Swap window associations in the auto-tiler
     *
     * Call this when a window has swapped positions with another, so that we
     * may update the associations in the auto-tiler world.
     */
    attach_swap(a: Entity, b: Entity) {
        const a_ent = this.attached.get(a),
            b_ent = this.attached.get(b);

        let a_win = this.ext.windows.get(a),
            b_win = this.ext.windows.get(b);

        if (!a_ent || !b_ent || !a_win || !b_win) return;

        const a_fork = this.forest.forks.get(a_ent),
            b_fork = this.forest.forks.get(b_ent);

        if (!a_fork || !b_fork) return;

        if (a_win.stack !== null) {
            const stack = this.forest.stacks.get(a_win.stack);
            if (stack) {
                a = stack.active;
                a_win = this.ext.windows.get(a);
                if (!a_win) return;
            }
        }

        if (b_win.stack !== null) {
            const stack = this.forest.stacks.get(b_win.stack);
            if (stack) {
                b = stack.active;
                b_win = this.ext.windows.get(b);
                if (!b_win) return;
            }
        }

        const a_fn = a_fork.replace_window(this.ext, a_win, b_win);

        const b_fn = b_fork.replace_window(this.ext, b_win, a_win);

        if (a_fn) a_fn();
        if (b_fn) b_fn();

        a_win.visibility.show_now();
        b_win.visibility.show_now();

        this.tile(a_fork, a_fork.area);
        this.tile(b_fork, b_fork.area);
    }

    update_tree(fork: Fork, monitor: MonitorID, smart_gaps: boolean) {
        const rect = this.ext.monitor_work_area(monitor);

        fork.smart_gapped = smart_gaps && fork.right === null;

        if (!fork.smart_gapped) {
            rect.x += this.ext.sizes.gap_outer;
            rect.y += this.ext.sizes.gap_outer;
            rect.width -= this.ext.sizes.gap_outer * 2;
            rect.height -= this.ext.sizes.gap_outer * 2;
        }

        const lone = fork.left.lone_window();
        if (lone) {
            const win = this.ext.windows.get(lone);
            if (win) {
                win.smart_gapped = fork.smart_gapped;
            }
        }

        fork.area = fork.set_area(rect.copy());
        fork.length_left = Math.round(fork.prev_ratio * fork.length());
        this.tile(fork, fork.area);
    }

    /** Attaches `win` to an optionally-given monitor */
    attach_to_monitor(win: MutterWindowHandle, workspace_id: MonitorWorkspaceID, smart_gaps: boolean) {
        const rect = this.ext.monitor_work_area(workspace_id[0]);

        if (!smart_gaps) {
            rect.x += this.ext.sizes.gap_outer;
            rect.y += this.ext.sizes.gap_outer;
            rect.width -= this.ext.sizes.gap_outer * 2;
            rect.height -= this.ext.sizes.gap_outer * 2;
        }

        const [, fork] = this.forest.add_tree(win.entity, rect.copy(), workspace_id);
        this.forest.on_attach(win.entity);
        fork.smart_gapped = smart_gaps;
        win.smart_gapped = smart_gaps;

        this.tile(fork, rect);
    }

    /** Tiles a window into another */
    attach_to_window(
        attachee: MutterWindowHandle,
        attacher: MutterWindowHandle,
        move_by: MoveBy,
        stack_from_left: boolean = true,
    ): boolean {
        const attached = this.forest.attach_window(
            this.ext,
            attachee.entity,
            attacher.entity,
            move_by,
            stack_from_left,
        );

        if (attached) {
            const [, fork] = attached;
            const monitor = this.ext.monitors.get(attachee.entity);
            if (monitor) {
                if (fork.is_root && fork.smart_gapped && fork.right) {
                    fork.smart_gapped = false;
                    const rect = this.ext.monitor_work_area(fork.monitor);

                    rect.x += this.ext.sizes.gap_outer;
                    rect.y += this.ext.sizes.gap_outer;
                    rect.width -= this.ext.sizes.gap_outer * 2;
                    rect.height -= this.ext.sizes.gap_outer * 2;

                    fork.set_area(rect);
                }

                this.tile(fork, fork.area.copy());
                return true;
            } else {
                Log.error(`missing monitor association for Window(${attachee.entity})`);
            }
        }

        return false;
    }

    /** Tile a window onto a workspace */
    attach_to_workspace(win: MutterWindowHandle, id: MonitorWorkspaceID) {
        if (this.ext.should_ignore_workspace(id[0])) {
            id = [id[0], 0];
        }

        const tree = this.forest.find_tree(id);

        if (tree) {
            const onto = this.forest.largest_window_on(this.ext, tree);
            if (onto) {
                if (this.attach_to_window(onto, win, { auto: 0 })) {
                    return;
                }
            }
        }

        this.attach_to_monitor(win, id, this.ext.settings.get_smart_gaps());
    }

    /** Automatically tiles a window into the window tree.
     *
     * ## Implementation Notes
     *
     * - First tries to tile onto the focused window
     * - Then tries to tile onto a monitor
     */
    auto_tile(win: MutterWindowHandle, ignore_focus: boolean = false) {
        const result = this.fetch_mode(win, ignore_focus);
        this.detach_window(win.entity);
        if (!result.ok) {
            Log.debug(`attach to workspace: ${result.why}`);
            this.attach_to_workspace(win, this.ext.workspace_id(win));
        } else {
            Log.debug(`attaching to window ${win.entity}`);
            this.attach_to_window(result.value, win, { auto: 0 });
        }
    }

    /** Destroy all widgets owned by this object. Call before dropping. */
    destroy() {
        for (const [, [fent]] of this.forest.trees_) {
            for (const node of this.forest.iter(fent)) {
                if (node.is_leaf()) {
                    for (const window of node.inner.entities) {
                        this.forest.on_detach(window);
                    }
                }
            }
        }

        for (const stack of this.forest.stacks.values()) stack.destroy();

        this.forest.stacks.truncate(0);
        this.ext.show_border_on_focused();
    }

    /** Detaches the window from a tiling branch, if it is attached to one. */
    detach_window(win: Entity) {
        const stack = this.find_stack(win)?.[1].inner;

        const prev_fork = this.attached.get(win);
        if (prev_fork) {
            const reflow_fork = this.forest.detach(this.ext, prev_fork, win);

            if (reflow_fork) {
                const fork = reflow_fork[1];
                if (fork.is_root && this.ext.settings.get_smart_gaps() && fork.right === null) {
                    const rect = this.ext.monitor_work_area(fork.monitor);
                    fork.set_area(rect);
                    fork.smart_gapped = true;
                }

                this.tile(fork, fork.area);
            }

            this.ext.windows.with(win, info => (info.ignore_detach = false));
        }

        if (stack?.kind === NodeKind.STACK) this.dissolve_single_stack(stack);
    }

    /** Turns a stack back into a plain window once only one window is left in it. */
    dissolve_single_stack(stack: node.NodeStack) {
        if (!this.ext.settings.get_dissolve_single_window_stacks()) return;
        if (stack.entities.length !== 1) return;

        const entity = stack.entities[0]!;
        const fork = this.get_parent_fork(entity);
        const window = this.ext.windows.get(entity);
        if (fork && window) this.unstack(fork, window);
    }

    /** Swaps the location of two windows if the dropped window was dropped onto its sibling */
    dropped_on_sibling(win: Entity, swap: boolean = true): boolean {
        const fork_entity = this.attached.get(win);

        if (fork_entity) {
            const cursor = lib.cursor_rect();
            const fork = this.forest.forks.get(fork_entity);

            if (fork) {
                const left = fork.left.lone_window();
                const right = fork.right?.lone_window() ?? null;

                if (left && right && fork.right) {
                    const sibling = this.ext.windows.get(ecs.entity_eq(left, win) ? right : left);
                    if (sibling && (ecs.entity_eq(left, win) || ecs.entity_eq(right, win))) {
                        if (sibling.frame().contains_rect(cursor)) {
                            if (swap) {
                                // Both are leaves of one window without tabs, so swapping the leaves
                                // swaps the windows
                                const temp = fork.left;
                                fork.left = fork.right;
                                fork.right = temp;

                                this.tile(fork, fork.area);
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

    largest_on_workspace(monitor: MonitorID, workspace: WorkspaceID): MutterWindowHandle | null {
        const workspace_id: MonitorWorkspaceID = [monitor, workspace];
        const tree = this.forest.find_tree(workspace_id);
        if (tree) {
            return this.forest.largest_window_on(this.ext, tree);
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
    on_drop(win: MutterWindowHandle, via_overview: boolean = false) {
        const [cursor, monitor] = this.ext.cursor_status();
        const workspace = this.ext.active_workspace();

        if (win.frame().contains_rect(cursor)) {
            via_overview = false;
        }

        const attach_mon = () => {
            const attach_to = this.largest_on_workspace(monitor, workspace);
            if (attach_to) {
                this.attach_to_window(attach_to, win, { auto: 0 });
            } else {
                this.attach_to_monitor(win, [monitor, workspace], this.ext.settings.get_smart_gaps());
            }
        };

        if (via_overview) {
            this.detach_window(win.entity);
            attach_mon();
            return;
        }

        let attach_to = null;
        for (const found of this.ext.windows_at_pointer(cursor, monitor, workspace)) {
            if (found != win && this.attached.contains(found.entity)) {
                attach_to = found;
                break;
            }
        }

        const fork = this.get_parent_fork(win.entity);
        if (!fork) return;

        const windowless = this.largest_on_workspace(monitor, workspace) === null;

        // If it appears to not be attaching to anything, assume we are attaching to its sibling
        if (attach_to === null) {
            const left = fork.left.lone_window();
            const right = fork.right?.lone_window() ?? null;
            if (left && right) {
                const attaching = ecs.entity_eq(left, win.entity) ? right : left;
                attach_to = this.ext.windows.get(attaching);
            } else if (!windowless) {
                this.tile(fork, fork.area);
            }
        }

        if (windowless) {
            this.detach_window(win.entity);
            this.attach_to_monitor(win, [monitor, workspace], this.ext.settings.get_smart_gaps());
        } else if (attach_to) {
            this.place_or_stack(win, attach_to, cursor);
        } else {
            this.detach_window(win.entity);
            attach_mon();
        }
    }

    place_or_stack(win: MutterWindowHandle, attach_to: MutterWindowHandle, cursor: Mtk.Rectangle): boolean {
        const fork = this.get_parent_fork(attach_to.entity);
        if (!fork) return true;

        const is_sibling = this.windows_are_siblings(win.entity, attach_to.entity);

        const attach_area: Mtk.Rectangle =
            (win.stack === null && attach_to.stack === null && is_sibling) || (win.stack === null && is_sibling)
                ? fork.area
                : attach_to.meta.get_frame_rect();

        let placement: MoveBy | null = cursor_placement(this.ext, attach_area, cursor);
        const stack = this.find_stack(attach_to.entity);

        const matching_stack = win.stack !== null && win.stack === attach_to.stack;
        const { Left, Up, Right, Down } = tiling.Direction;

        const swap = (o: Clutter.Orientation, d: tiling.Direction) => {
            fork.set_orientation(o);
            const is_left = fork.left.is_window(win.entity);
            const swap = (is_left && (d == Right || d == Down)) || (!is_left && (d == Left || d == Up));

            if (swap) {
                fork.swap_branches();
            }

            this.tile(fork, fork.area);
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
                    this.ext.gnome_tiling_mode.move_from_stack(stack, win, direction, true);
                    return true;
                } else if (attach_to.stack !== null) {
                    const onto_stack = this.find_stack(attach_to.entity);
                    if (onto_stack) {
                        if (is_sibling && win.stack === null) {
                            swap(placement.orientation, direction);
                            return true;
                        } else {
                            this.ext.gnome_tiling_mode.move_alongside_stack(onto_stack, win, direction);
                        }

                        return true;
                    }
                }
            } else if (is_sibling && win.stack === null) {
                swap(placement.orientation, direction);
                return true;
            } else if (fork.is_root && fork.right === null) {
                this.detach_window(win.entity);
                this.attach_to_window(attach_to, win, placement);
                swap(placement.orientation, direction);
                return true;
            }
        } else if (matching_stack) {
            this.tile(fork, fork.area);
            return true;
        } else {
            if (attach_to.stack === null) this.create_stack(attach_to);

            placement = { auto: 0 };
        }

        this.detach_window(win.entity);
        return this.attach_to_window(attach_to, win, placement);
    }

    /** Schedules a fork to be reflowed */
    reflow(win: Entity) {
        const fork_entity = this.attached.get(win);
        if (!fork_entity) return;

        this.ext.register_fn(() => {
            const fork = this.forest.forks.get(fork_entity);
            if (fork) this.tile(fork, fork.area);
        });
    }

    tile(fork: Fork, area: Mtk.Rectangle) {
        this.forest.tile(this.ext, fork, area);
    }

    toggle_floating() {
        const focused = this.ext.get_focused_window();
        if (!focused) return;

        if (focused.was_tilable) {
            this.ext.delete_tag(focused.entity, Tags.ForceTile);
            const fork_entity = this.attached.get(focused.entity);
            if (fork_entity) {
                this.detach_window(focused.entity);
            }
            this.ext.add_tag(focused.entity, Tags.Floating);
        } else {
            this.ext.delete_tag(focused.entity, Tags.Floating);
            this.ext.add_tag(focused.entity, Tags.ForceTile);
            this.auto_tile(focused, false);
        }
        focused.reconsider_tiling();

        this.ext.register_fn(() => focused.request_activate(true));
    }

    toggle_orientation(window: MutterWindowHandle) {
        const result = this.toggle_orientation_(window);
        if (!result.ok) {
            Log.warn(`toggle_orientation: ${result.why}`);
        }
    }

    toggle_stacking(window?: MutterWindowHandle) {
        const focused = window ?? this.ext.get_focused_window();
        if (!focused) return;

        // Disable floating if floating is enabled
        if (this.ext.contains_tag(focused.entity, Tags.Floating)) {
            this.ext.delete_tag(focused.entity, Tags.Floating);
            this.auto_tile(focused, false);
        }

        const fork_entity = this.attached.get(focused.entity);

        if (fork_entity) {
            const fork = this.forest.forks.get(fork_entity);
            if (fork) {
                this.unstack(fork, focused, true);
            }
        }
    }

    unstack(fork: Fork, win: MutterWindowHandle, toggled: boolean = false) {
        if (toggled && fork.left.is_window(win.entity)) {
            this.add_tabs(fork, fork.left);
            fork.measure(this.forest, this.ext, fork.area, this.forest.on_record());
        } else if (fork.left.is_in_stack(win.entity)) {
            // Only a stack of one window loses its tabs
            if (fork.left.inner.entities.length === 1) {
                this.remove_tabs(fork.left);
                fork.measure(this.forest, this.ext, fork.area, this.forest.on_record());
                if (!fork.right) this.forest.reassign_to_parent(fork, fork.left);
            }
        } else if (toggled && fork.right && fork.right.is_window(win.entity)) {
            this.add_tabs(fork, fork.right);
            fork.measure(this.forest, this.ext, fork.area, this.forest.on_record());
        } else if (fork.right && fork.right.is_in_stack(win.entity)) {
            if (fork.right.inner.entities.length === 1) {
                this.remove_tabs(fork.right);
                fork.measure(this.forest, this.ext, fork.area, this.forest.on_record());
            }
        }

        this.tile(fork, fork.area);
    }

    /** Gives a leaf tabs, along with the Stack that draws them, so that it can hold more windows */
    private add_tabs(fork: Fork, leaf: node.Node<node.NodeStack>) {
        if (leaf.inner.tabbed) return;

        leaf.inner.tabbed = true;
        leaf.inner.idx = this.forest.stacks.insert(new Stack(this.ext, leaf.inner, fork.workspace));
    }

    /** Takes the tabs from a leaf of one window, which releases the window */
    private remove_tabs(leaf: node.Node<node.NodeStack>) {
        if (leaf.inner.idx !== null) this.forest.stacks.remove(leaf.inner.idx)?.destroy();

        leaf.inner.tabbed = false;
        leaf.inner.idx = null;
    }

    /** Gives the leaf of a window tabs, if it has none yet */
    create_stack(window: MutterWindowHandle) {
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

        this.add_tabs(fork, leaf);
        fork.measure(this.forest, this.ext, fork.area, this.forest.on_record());
    }

    /** Draws a stack again from the tree, and places its tab bar if it has been measured */
    update_stack(stack: node.NodeStack) {
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

    private fetch_mode(win: MutterWindowHandle, ignore_focus: boolean = false): Result<MutterWindowHandle, string> {
        if (ignore_focus) {
            return Err('ignoring focus');
        }

        const prev = this.ext.focus_history.previous_to(win.entity);

        if (!prev) {
            return Err('no window has been previously focused');
        }

        const onto = this.ext.windows.get(prev);

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

    private toggle_orientation_(focused: MutterWindowHandle): Result<void, string> {
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
        this.forest.measure(this.ext, fork, fork.area);

        for (const child of this.forest.iter(fork_entity)) {
            if (child.inner.kind != NodeKind.FORK) continue;

            const entity = child.inner.entity;
            const child_fork = this.forest.forks.get(entity);
            if (child_fork) {
                child_fork.rebalance_orientation();
                this.forest.measure(this.ext, child_fork, child_fork.area);
            } else {
                Log.error(`toggle_orientation: Fork(${entity}) does not exist to have its orientation toggled`);
            }
        }

        this.forest.arrange(this.ext, fork.workspace, true);

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

    const { side } = geom.nearest_side([cursor.x, cursor.y], area, ext.settings.get_stacking_with_mouse());

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
