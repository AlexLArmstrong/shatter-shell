import Clutter from 'gi://Clutter';
import Mtk from 'gi://Mtk';

import type { Entity } from './ecs.js';
import type { Ext } from './extension.js';
import type { Forest } from './forest.js';
import type { Node, NodeLeaf } from './node.js';

import * as Ecs from './ecs.js';
import { MutterWindowHandle } from './gnome/mutter_window_handle.js';
import * as node from './node.js';
import { TAB_HEIGHT_UNSCALED } from './stack.js';
const { NodeKind } = node;

const XPOS = 'x' as const;
const YPOS = 'y' as const;
const WIDTH = 'width' as const;
const HEIGHT = 'height' as const;

/** The links back up a tree, which its forks keep in step with their branches */
export interface TreeLinks {
    /** The fork with this entity */
    fork(entity: Entity): Fork | null;

    /** The leaf that holds each tiled window */
    readonly leaves: Ecs.Storage<NodeLeaf>;
}

/** A tiling fork contains two children nodes.
 *
 * These nodes may either be windows, or sub-forks.
 */
export class Fork {
    private _left: Node;
    private _right: Node | null;

    /** The fork whose branch this one is, if it isn't the top of its tree */
    parent: Fork | null = null;

    area: Mtk.Rectangle;
    entity: Entity;
    on_primary_display: boolean;
    workspace: WorkspaceID;
    length_left: number;
    prev_length_left: number;
    prev_ratio: number = 0.5;
    monitor: MonitorID;
    minimum_ratio: number = 0.1;
    orientation;

    orientation_changed: boolean = false;
    is_toplevel: boolean = false;

    smart_gapped: boolean = false;

    /** Tracks toggle count so that we may swap branches when toggled twice */
    private n_toggled: number = 0;

    constructor(
        private readonly links: TreeLinks,
        entity: Entity,
        left: Node,
        right: Node | null,
        area: Mtk.Rectangle,
        workspace: WorkspaceID,
        monitor: MonitorID,
        orientation = Clutter.Orientation.HORIZONTAL,
    ) {
        this.on_primary_display = global.display.get_primary_monitor() === monitor;
        this.area = area;
        this._left = left;
        this._right = right;
        this.hold(left);
        if (right) this.hold(right);
        this.workspace = workspace;
        this.length_left = orientation === Clutter.Orientation.HORIZONTAL ? this.area.width / 2 : this.area.height / 2;
        this.prev_length_left = this.length_left;
        this.entity = entity;
        this.orientation = orientation;
        this.monitor = monitor;
    }

    get left(): Node {
        return this._left;
    }

    set left(branch: Node) {
        const previous = this._left;
        this._left = branch;
        this.replaced(previous, branch);
    }

    get right(): Node | null {
        return this._right;
    }

    set right(branch: Node | null) {
        const previous = this._right;
        this._right = branch;
        this.replaced(previous, branch);
    }

    /** Lets go of everything the fork held, as it leaves its tree */
    leave() {
        this.let_go(this._left);
        if (this._right) this.let_go(this._right);
    }

    /** Records that the window is in this fork's leaf */
    hold_window(leaf: NodeLeaf, window: Entity) {
        this.links.leaves.insert(window, leaf);
    }

    /** Forgets that the window is in the leaf, unless it has moved to another leaf since */
    let_go_window(leaf: NodeLeaf, window: Entity) {
        if (this.links.leaves.get(window) === leaf) this.links.leaves.remove(window);
    }

    private replaced(previous: Node | null, branch: Node | null) {
        if (branch) this.hold(branch);
        if (previous && previous !== this._left && previous !== this._right) this.let_go(previous);
    }

    private hold(branch: Node) {
        const inner = branch.inner;
        inner.parent = this;
        switch (inner.kind) {
            case NodeKind.FORK:
                const child = this.links.fork(inner.entity);
                if (child) child.parent = this;
                break;
            case NodeKind.STACK:
                for (const window of inner.entities) this.hold_window(inner, window);
                break;
        }
    }

    private let_go(branch: Node) {
        const inner = branch.inner;
        if (inner.parent !== this) return;
        inner.parent = null;
        switch (inner.kind) {
            case NodeKind.FORK:
                const child = this.links.fork(inner.entity);
                if (child?.parent === this) child.parent = null;
                break;
            case NodeKind.STACK:
                for (const window of inner.entities) this.let_go_window(inner, window);
                break;
        }
    }

    /** The calculated left area of this fork */
    area_of_left(ext: Ext): Mtk.Rectangle {
        let { x, y, width, height } = this.area;
        if (this.is_horizontal()) {
            width = this.length_left - ext.sizes.gap_inner_half;
        } else {
            height = this.length_left - ext.sizes.gap_inner_half;
        }
        return new Mtk.Rectangle({ x, y, width, height });
    }

    /** The calculated right area of this fork */
    area_of_right(ext: Ext): Mtk.Rectangle {
        let { x, y, width, height } = this.area;
        if (this.is_horizontal()) {
            x = x + this.length_left + ext.sizes.gap_inner_half;
            width = width - this.length_left - ext.sizes.gap_inner_half;
        } else {
            y = y + this.length_left + ext.sizes.gap_inner_half;
            height = height - this.length_left - ext.sizes.gap_inner_half;
        }
        return new Mtk.Rectangle({ x, y, width, height });
    }

    depth(): number {
        return this.is_horizontal() ? this.area.height : this.area.width;
    }

    find_branch(entity: Entity): Node | null {
        const locate = (branch: Node): Node | null => (branch.has(entity) ? branch : null);

        const node = locate(this.left);
        if (node) return node;

        return this.right ? locate(this.right) : null;
    }

    /** If this fork has a horizontal orientation */
    is_horizontal(): boolean {
        return this.orientation == Clutter.Orientation.HORIZONTAL;
    }

    length(): number {
        return this.is_horizontal() ? this.area.width : this.area.height;
    }

    /** Replaces the association of a window in a fork with another */
    replace_window(ext: Ext, a: MutterWindowHandle, b: MutterWindowHandle): (() => void) | null {
        const branch = this.left.has(a.entity) ? this.left : this.right?.has(a.entity) ? this.right : null;
        if (!branch?.is_leaf()) return null;

        const leaf = branch.inner;
        return () => node.stack_replace(ext, leaf, a.entity, b.entity);
    }

    /** Sets a new area for this fork */
    set_area(area: Mtk.Rectangle): Mtk.Rectangle {
        this.area = area;
        return this.area;
    }

    /** Sets the ratio of this fork
     *
     * Ensures that the ratio is never smaller or larger than the constraints.
     */
    set_ratio(left_length: number): Fork {
        const fork_len = this.is_horizontal() ? this.area.width : this.area.height;
        const clamped = Math.round(Math.max(256, Math.min(fork_len - 256, left_length)));
        this.prev_length_left = clamped;
        this.length_left = clamped;
        return this;
    }

    /** Defines this fork as a top level fork, and records it in the forest */
    set_toplevel(tiler: Forest, entity: Entity, string: string, id: MonitorWorkspaceID): Fork {
        this.is_toplevel = true;
        tiler.toplevel.set(string, [entity, id]);
        return this;
    }

    /** Calculates the future arrangement of windows in this fork */
    measure(
        tiler: Forest,
        ext: Ext,
        area: Mtk.Rectangle,
        record: (win: Entity, parent: Entity, area: Mtk.Rectangle) => void,
    ) {
        let ratio = null;

        const manually_moved = ext.grab.window !== null || ext.gnome_tiling_mode.resizing_window;

        if (!this.is_toplevel) {
            if (this.orientation_changed) {
                this.orientation_changed = false;
                ratio = this.length_left / this.depth();
            } else {
                ratio = this.length_left / this.length();
            }

            this.area = this.set_area(area.copy());
        } else if (this.orientation_changed) {
            this.orientation_changed = false;
            ratio = this.length_left / this.depth();
        }

        if (ratio != null) {
            this.length_left = Math.round(ratio * this.length());
            if (manually_moved) this.prev_ratio = ratio;
        } else if (manually_moved) {
            this.prev_ratio = this.length_left / this.length();
        }

        if (this.right) {
            const [l, p, startpos] = this.is_horizontal() ? [WIDTH, XPOS, this.area.x] : [HEIGHT, YPOS, this.area.y];

            const region = this.area.copy();

            const half = this.area[l] / 2;

            let length;
            if (this.length_left > half - 32 && this.length_left < half + 32) {
                length = half;
            } else {
                const diff = (startpos + this.length_left) % 32;
                length = this.length_left - diff + (diff > 16 ? 32 : 0);
                if (length == 0) length = 32;
            }

            const gap = ext.sizes.gap_inner_half;
            const left_size = minimum_size(tiler, ext, this.left);
            const left_min = left_size[this.is_horizontal() ? 0 : 1];
            const right_size = minimum_size(tiler, ext, this.right);
            const right_min = right_size[this.is_horizontal() ? 0 : 1];
            const lower_bound = left_min + gap;
            const upper_bound = this.area[l] - right_min - gap;
            if (lower_bound <= upper_bound) {
                if (length < lower_bound) {
                    this.length_left = length = lower_bound;
                } else if (length > upper_bound) {
                    this.length_left = length = upper_bound;
                }
            }

            region[l] = length - ext.sizes.gap_inner_half;

            this.left.measure(tiler, ext, this.entity, region, record);

            region[p] = region[p] + length + ext.sizes.gap_inner_half;
            region[l] = this.area[l] - length - ext.sizes.gap_inner_half;

            this.right.measure(tiler, ext, this.entity, region, record);
        } else {
            this.left.measure(tiler, ext, this.entity, this.area, record);
        }
    }

    migrate(ext: Ext, forest: Forest, area: Mtk.Rectangle, monitor: MonitorID, workspace: WorkspaceID) {
        if (ext.gnome_forest && this.is_toplevel) {
            const primary = global.display.get_primary_monitor() === monitor;

            this.monitor = monitor;
            this.workspace = workspace;
            this.on_primary_display = primary;

            const blocked = [];

            forest.toplevel.set(forest.string_reps.get(this.entity)!, [this.entity, [monitor, workspace]]);

            for (const child of forest.iter(this.entity)) {
                switch (child.inner.kind) {
                    case NodeKind.FORK:
                        const cfork = forest.forks.get(child.inner.entity);
                        if (!cfork) continue;
                        cfork.workspace = workspace;
                        cfork.monitor = monitor;
                        cfork.on_primary_display = primary;
                        break;
                    case NodeKind.STACK:
                        for (const entity of child.inner.entities) {
                            const window = ext.windows.get(entity);

                            if (window) {
                                ext.size_signals_block(window);
                                window.reassignment = false;
                                window.known_workspace = workspace;
                                window.meta.change_workspace_by_index(workspace, true);
                                ext.monitors.insert(window.entity, [monitor, workspace]);
                                blocked.push(window);
                            }
                        }
                }
            }

            area.x += ext.sizes.gap_outer;
            area.y += ext.sizes.gap_outer;
            area.width -= ext.sizes.gap_outer * 2;
            area.height -= ext.sizes.gap_outer * 2;

            this.set_area(area.copy());
            this.measure(forest, ext, area, forest.on_record());
            forest.arrange(ext, workspace, true);

            for (const window of blocked) {
                ext.size_signals_unblock(window);
            }
        }
    }

    rebalance_orientation() {
        this.set_orientation(
            this.area.height > this.area.width ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
        );
    }

    set_orientation(o: Clutter.Orientation) {
        if (o !== this.orientation) {
            this.orientation = o;
            this.orientation_changed = true;
        }
    }

    /** Swaps the left branch with the right branch, if there is a right branch */
    swap_branches() {
        if (this.right) {
            const temp = this.left;
            this.left = this.right;
            this.right = temp;
        }
    }

    /** Toggles the orientation of this fork */
    toggle_orientation() {
        this.orientation =
            this.orientation === Clutter.Orientation.HORIZONTAL
                ? Clutter.Orientation.VERTICAL
                : Clutter.Orientation.HORIZONTAL;

        this.orientation_changed = true;
        if (this.n_toggled === 1) {
            if (this.right) {
                const tmp = this.right;
                this.right = this.left;
                this.left = tmp;
            }
            this.n_toggled = 0;
        } else {
            this.n_toggled += 1;
        }
    }
}

function minimum_size(tiler: Forest, ext: Ext, branch: Node): [number, number] {
    switch (branch.inner.kind) {
        case NodeKind.STACK:
            // A leaf without tabs is a window on its own
            if (!branch.inner.tabbed) return window_minimum_size(ext, branch.inner.entities[0]!);
            return stack_minimum_size(ext, branch.inner.entities);
        case NodeKind.FORK:
            return fork_minimum_size(ext, tiler, branch.inner.entity);
    }
}

function window_minimum_size(ext: Ext, entity: Entity): [number, number] {
    return ext.windows.get(entity)?.minimum_size() ?? [0, 0];
}

/** Gets the stack's minimum size based on its windows and the tab bar. */
function stack_minimum_size(ext: Ext, entities: Entity[]): [number, number] {
    let width = 0;
    let height = 0;
    for (const entity of entities) {
        const [window_width, window_height] = window_minimum_size(ext, entity);
        width = Math.max(width, window_width);
        height = Math.max(height, window_height);
    }
    return [width, height + ext.sizes.scale * TAB_HEIGHT_UNSCALED];
}

/** Gets the fork's minimum size based on its left and right nodes. */
function fork_minimum_size(ext: Ext, tiler: Forest, entity: Entity): [number, number] {
    const fork = tiler.forks.get(entity);
    if (!fork) return [0, 0];

    const [left_width, left_height] = minimum_size(tiler, ext, fork.left);
    if (!fork.right) return [left_width, left_height];

    const [right_width, right_height] = minimum_size(tiler, ext, fork.right);
    if (fork.is_horizontal()) {
        return [left_width + right_width + ext.sizes.gap_inner, Math.max(left_height, right_height)];
    } else {
        return [Math.max(left_width, right_width), left_height + right_height + ext.sizes.gap_inner];
    }
}
