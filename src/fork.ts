import Meta from 'gi://Meta';

import type { LayoutSizes } from './core/layout_sizes.js';
import type { Layout, Node, NodeLeaf, TabBars } from './node.js';

import { copy_rect, whole_rect, type Rect } from './core/geom.js';
import { Orientation } from './core/orientation.js';
import { MutterWindowHandle } from './gnome/mutter_window_handle.js';
import { workspaceID } from './lib.js';
import * as node from './node.js';
const { NodeKind } = node;

const XPOS = 'x' as const;
const YPOS = 'y' as const;
const WIDTH = 'width' as const;
const HEIGHT = 'height' as const;

/** The links back up a tree, which its forks keep in step with their branches */
export interface TreeLinks {
    /** The leaf that holds each tiled window */
    readonly leaves: Map<WindowId, NodeLeaf>;
}

/** A tree of forks: its root fork, and where it is, which all of its forks share */
export class Tree {
    /** The fork at the root of the tree, for as long as the tree lives */
    root!: Fork;

    monitor: MonitorID;

    /**
     * The workspace that the tree is on, which it keeps when the workspaces are renumbered. It's
     * only compared, never asked anything.
     */
    workspace: Meta.Workspace;

    /** Set once mutter has removed the workspace, which then has no index, until the tree moves on */
    workspace_removed = false;

    on_primary_display: boolean;

    constructor(monitor: MonitorID, workspace: Meta.Workspace) {
        this.monitor = monitor;
        this.workspace = workspace;
        this.on_primary_display = global.display.get_primary_monitor() === monitor;
    }

    /** Moves the tree to another workspace */
    move_to(workspace: Meta.Workspace) {
        this.workspace = workspace;
        this.workspace_removed = false;
    }

    /** Whether the tree is on this workspace, given by its index as it is now */
    is_on(workspace: WorkspaceID): boolean {
        return global.workspace_manager.get_workspace_by_index(workspace) === this.workspace;
    }
}

let next_fork_id = 1;

/**
 * A tiling fork contains two children nodes, which may either be leaves or sub-forks.
 *
 * Only the root fork of a tree may have just one child, its left: a fork below it that is left with
 * one child is replaced by that child.
 */
export class Fork {
    private _left: Node;
    private _right: Node | null;

    /** The fork whose branch this one is, if it isn't the root of its tree */
    parent: Fork | null = null;

    area: Rect;

    /** A number that tells forks apart in logs */
    readonly id: number = next_fork_id++;

    /**
     * Whether the fork has left the tree. A node of the tree that still links to it is out of date,
     * so walks of the tree skip it.
     */
    detached: boolean = false;
    /** The tree that the fork is in, which all of its forks share */
    readonly tree: Tree;
    length_left: number;
    prev_length_left: number;
    prev_ratio: number = 0.5;
    minimum_ratio: number = 0.1;
    orientation;

    orientation_changed: boolean = false;

    smart_gapped: boolean = false;

    /** Tracks toggle count so that we may swap branches when toggled twice */
    private n_toggled: number = 0;

    constructor(
        private readonly links: TreeLinks,
        left: Node,
        right: Node | null,
        area: Rect,
        tree: Tree,
        orientation = Orientation.HORIZONTAL,
    ) {
        this.area = area;
        this._left = left;
        this._right = right;
        this.hold(left);
        if (right) this.hold(right);
        this.tree = tree;
        this.length_left = orientation === Orientation.HORIZONTAL ? this.area.width / 2 : this.area.height / 2;
        this.prev_length_left = this.length_left;
        this.orientation = orientation;
    }

    get is_root(): boolean {
        return this.tree.root === this;
    }

    /** The index of the tree's workspace as it is now, or -1 if it has been removed */
    get workspace(): WorkspaceID {
        return workspaceID(this.tree.workspace_removed ? -1 : this.tree.workspace.index());
    }

    /** Moves the tree to the workspace that has this index now */
    set workspace(workspace: WorkspaceID) {
        const found = global.workspace_manager.get_workspace_by_index(workspace);
        if (found) this.tree.move_to(found);
    }

    get monitor(): MonitorID {
        return this.tree.monitor;
    }

    set monitor(monitor: MonitorID) {
        this.tree.monitor = monitor;
    }

    get on_primary_display(): boolean {
        return this.tree.on_primary_display;
    }

    set on_primary_display(primary: boolean) {
        this.tree.on_primary_display = primary;
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
    hold_window(leaf: NodeLeaf, window: WindowId) {
        this.links.leaves.set(window, leaf);
    }

    /** Forgets that the window is in the leaf, unless it has moved to another leaf since */
    let_go_window(leaf: NodeLeaf, window: WindowId) {
        if (this.links.leaves.get(window) === leaf) this.links.leaves.delete(window);
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
                inner.fork.parent = this;
                break;
            case NodeKind.STACK:
                for (const window of inner.windows) this.hold_window(inner, window);
                break;
        }
    }

    private let_go(branch: Node) {
        const inner = branch.inner;
        if (inner.parent !== this) return;
        inner.parent = null;
        switch (inner.kind) {
            case NodeKind.FORK:
                if (inner.fork.parent === this) inner.fork.parent = null;
                break;
            case NodeKind.STACK:
                for (const window of inner.windows) this.let_go_window(inner, window);
                break;
        }
    }

    /** The calculated left area of this fork */
    area_of_left(sizes: LayoutSizes): Rect {
        let { x, y, width, height } = this.area;
        if (this.is_horizontal()) {
            width = this.length_left - sizes.gap_inner_half;
        } else {
            height = this.length_left - sizes.gap_inner_half;
        }
        return whole_rect(x, y, width, height);
    }

    /** The calculated right area of this fork */
    area_of_right(sizes: LayoutSizes): Rect {
        let { x, y, width, height } = this.area;
        if (this.is_horizontal()) {
            x = x + this.length_left + sizes.gap_inner_half;
            width = width - this.length_left - sizes.gap_inner_half;
        } else {
            y = y + this.length_left + sizes.gap_inner_half;
            height = height - this.length_left - sizes.gap_inner_half;
        }
        return whole_rect(x, y, width, height);
    }

    depth(): number {
        return this.is_horizontal() ? this.area.height : this.area.width;
    }

    find_branch(window_id: WindowId): Node | null {
        const locate = (branch: Node): Node | null => (branch.has(window_id) ? branch : null);

        const node = locate(this.left);
        if (node) return node;

        return this.right ? locate(this.right) : null;
    }

    /** If this fork has a horizontal orientation */
    is_horizontal(): boolean {
        return this.orientation == Orientation.HORIZONTAL;
    }

    length(): number {
        return this.is_horizontal() ? this.area.width : this.area.height;
    }

    /** Replaces the association of a window in a fork with another */
    replace_window(tabs: TabBars, a: MutterWindowHandle, b: MutterWindowHandle): (() => void) | null {
        const branch = this.left.has(a.id) ? this.left : this.right?.has(a.id) ? this.right : null;
        if (!branch?.is_leaf()) return null;

        const leaf = branch.inner;
        return () => node.stack_replace(tabs, leaf, a.id, b.id);
    }

    /** Sets a new area for this fork */
    set_area(area: Rect): Rect {
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

    /** Calculates the future arrangement of windows in this fork */
    measure(layout: Layout, area: Rect) {
        let ratio = null;

        const manually_moved = layout.manually_moved();

        if (!this.is_root) {
            if (this.orientation_changed) {
                this.orientation_changed = false;
                ratio = this.length_left / this.depth();
            } else {
                ratio = this.length_left / this.length();
            }

            this.area = this.set_area(copy_rect(area));
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

            const region = copy_rect(this.area);

            const half = this.area[l] / 2;

            let length;
            if (this.length_left > half - 32 && this.length_left < half + 32) {
                length = half;
            } else {
                const diff = (startpos + this.length_left) % 32;
                length = this.length_left - diff + (diff > 16 ? 32 : 0);
                if (length == 0) length = 32;
            }

            const gap = layout.gap_inner_half;
            const left_size = minimum_size(layout, this.left);
            const left_min = left_size[this.is_horizontal() ? 0 : 1];
            const right_size = minimum_size(layout, this.right);
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

            region[l] = Math.trunc(length - layout.gap_inner_half);

            this.left.measure(layout, this, region);

            region[p] = Math.trunc(region[p] + length + layout.gap_inner_half);
            region[l] = Math.trunc(this.area[l] - length - layout.gap_inner_half);

            this.right.measure(layout, this, region);
        } else {
            this.left.measure(layout, this, this.area);
        }
    }

    rebalance_orientation() {
        this.set_orientation(this.area.height > this.area.width ? Orientation.VERTICAL : Orientation.HORIZONTAL);
    }

    set_orientation(o: Orientation) {
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
        this.orientation = this.orientation === Orientation.HORIZONTAL ? Orientation.VERTICAL : Orientation.HORIZONTAL;

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

function minimum_size(layout: Layout, branch: Node): [number, number] {
    switch (branch.inner.kind) {
        case NodeKind.STACK:
            // A leaf without tabs is a window on its own
            if (!branch.inner.tabbed) return layout.minimum_size(branch.inner.windows[0]!);
            return stack_minimum_size(layout, branch.inner.windows);
        case NodeKind.FORK:
            return fork_minimum_size(layout, branch.inner.fork);
    }
}

/** Gets the stack's minimum size based on its windows and the tab bar. */
function stack_minimum_size(layout: Layout, windows: WindowId[]): [number, number] {
    let width = 0;
    let height = 0;
    for (const window_id of windows) {
        const [window_width, window_height] = layout.minimum_size(window_id);
        width = Math.max(width, window_width);
        height = Math.max(height, window_height);
    }
    return [width, height + layout.tab_height()];
}

/** Gets the fork's minimum size based on its left and right nodes. */
function fork_minimum_size(layout: Layout, fork: Fork): [number, number] {
    if (fork.detached) return [0, 0];

    const [left_width, left_height] = minimum_size(layout, fork.left);
    if (!fork.right) return [left_width, left_height];

    const [right_width, right_height] = minimum_size(layout, fork.right);
    if (fork.is_horizontal()) {
        return [left_width + right_width + layout.gap_inner, Math.max(left_height, right_height)];
    } else {
        return [Math.max(left_width, right_width), left_height + right_height + layout.gap_inner];
    }
}
