import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import type { Entity } from './ecs.js';
import type { Ext } from './extension.js';
import type { Forest } from './forest.js';
import type { Node } from './node.js';

import { workspaceID } from './lib.js';
import * as node from './node.js';
import { ShellWindow } from './window.js';
const { NodeKind } = node;

const XPOS = 'x' as const;
const YPOS = 'y' as const;
const WIDTH = 'width' as const;
const HEIGHT = 'height' as const;

/**
 * What a tree knows about where it is: its monitor and its workspace. Every fork of the tree shares
 * this one object, so that moving the tree only changes it once, and its forks can't disagree.
 */
export class Root {
    monitor: MonitorID;

    /**
     * The workspace that the tree is on. This is mutter's own workspace rather than its index, as
     * mutter renumbers the workspaces whenever one before it is removed or they're reordered, and the
     * tree must stay where it is. Once its workspace has been removed, it's only compared, never
     * asked anything, until the tree's windows have moved on.
     */
    workspace: Meta.Workspace;

    on_primary_display: boolean;

    constructor(monitor: MonitorID, workspace: Meta.Workspace) {
        this.monitor = monitor;
        this.workspace = workspace;
        this.on_primary_display = global.display.get_primary_monitor() === monitor;
    }

    /** Whether the tree's workspace still exists, rather than having been removed */
    workspace_exists(): boolean {
        const manager = global.workspace_manager;
        for (let idx = 0; idx < manager.get_n_workspaces(); idx += 1) {
            if (manager.get_workspace_by_index(idx) === this.workspace) return true;
        }

        return false;
    }

    /** Whether the tree is on this workspace, given by its index as it is now */
    is_on(workspace: WorkspaceID): boolean {
        return global.workspace_manager.get_workspace_by_index(workspace) === this.workspace;
    }
}

/**
 * A tiling fork contains two children nodes, which may either be leaves or sub-forks.
 *
 * Only the top fork of a tree may have just one child, its left: a fork below it that is left with
 * one child is replaced by that child.
 */
export class Fork {
    left: Node;
    right: Node | null;
    area: Mtk.Rectangle;
    entity: Entity;
    /**
     * Whether the fork has left the tree, and its entity been deleted. A node of the tree that still
     * links to it is out of date, so walks of the tree skip it, as they did when they looked it up.
     */
    detached: boolean = false;
    /** The tree's monitor and workspace, which all of its forks share */
    readonly root: Root;
    length_left: number;
    prev_length_left: number;
    prev_ratio: number = 0.5;
    minimum_ratio: number = 0.1;
    orientation;

    orientation_changed: boolean = false;
    is_toplevel: boolean = false;

    smart_gapped: boolean = false;

    /** Tracks toggle count so that we may swap branches when toggled twice */
    private n_toggled: number = 0;

    constructor(
        entity: Entity,
        left: Node,
        right: Node | null,
        area: Mtk.Rectangle,
        root: Root,
        orientation = Clutter.Orientation.HORIZONTAL,
    ) {
        this.area = area;
        this.left = left;
        this.right = right;
        this.root = root;
        this.length_left = orientation === Clutter.Orientation.HORIZONTAL ? this.area.width / 2 : this.area.height / 2;
        this.prev_length_left = this.length_left;
        this.entity = entity;
        this.orientation = orientation;
    }

    /** The index of the tree's workspace as it is now, or -1 if it has been removed */
    get workspace(): WorkspaceID {
        return workspaceID(this.root.workspace_exists() ? this.root.workspace.index() : -1);
    }

    /** Moves the tree to the workspace that has this index now */
    set workspace(workspace: WorkspaceID) {
        const found = global.workspace_manager.get_workspace_by_index(workspace);
        if (found) this.root.workspace = found;
    }

    /** The tree's monitor */
    get monitor(): MonitorID {
        return this.root.monitor;
    }

    set monitor(monitor: MonitorID) {
        this.root.monitor = monitor;
    }

    /** Whether the tree is on the primary monitor */
    get on_primary_display(): boolean {
        return this.root.on_primary_display;
    }

    set on_primary_display(primary: boolean) {
        this.root.on_primary_display = primary;
    }

    /** The calculated left area of this fork */
    area_of_left(ext: Ext): Mtk.Rectangle {
        let { x, y, width, height } = this.area;
        if (this.is_horizontal()) {
            width = this.length_left - ext.gap_inner_half;
        } else {
            height = this.length_left - ext.gap_inner_half;
        }
        return new Mtk.Rectangle({ x, y, width, height });
    }

    /** The calculated right area of this fork */
    area_of_right(ext: Ext): Mtk.Rectangle {
        let { x, y, width, height } = this.area;
        if (this.is_horizontal()) {
            x = x + this.length_left + ext.gap_inner_half;
            width = width - this.length_left - ext.gap_inner_half;
        } else {
            y = y + this.length_left + ext.gap_inner_half;
            height = height - this.length_left - ext.gap_inner_half;
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
    replace_window(ext: Ext, a: ShellWindow, b: ShellWindow): (() => void) | null {
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

    /** Calculates the future arrangement of windows in this fork */
    measure(
        tiler: Forest,
        ext: Ext,
        area: Mtk.Rectangle,
        record: (win: Entity, parent: Entity, area: Mtk.Rectangle) => void,
    ) {
        let ratio = null;

        const manually_moved = ext.grab_op !== null || ext.tiler.resizing_window;

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

            region[l] = length - ext.gap_inner_half;

            this.left.measure(tiler, ext, this.entity, region, record);

            region[p] = region[p] + length + ext.gap_inner_half;
            region[l] = this.area[l] - length - ext.gap_inner_half;

            this.right.measure(tiler, ext, this.entity, region, record);
        } else {
            this.left.measure(tiler, ext, this.entity, this.area, record);
        }
    }

    migrate(ext: Ext, forest: Forest, area: Mtk.Rectangle, monitor: MonitorID, workspace: WorkspaceID) {
        if (ext.auto_tiler && this.is_toplevel) {
            const primary = global.display.get_primary_monitor() === monitor;

            this.monitor = monitor;
            this.workspace = workspace;
            this.on_primary_display = primary;

            const blocked = [];

            for (const child of forest.iter(this.entity)) {
                switch (child.inner.kind) {
                    case NodeKind.FORK:
                        // Its monitor and workspace are the root's, which have already changed
                        break;
                    case NodeKind.STACK:
                        for (const entity of child.inner.entities) {
                            const window = ext.windows.get(entity);

                            if (window) {
                                ext.size_signals_block(window);
                                window.reassignment = false;
                                window.meta.change_workspace_by_index(workspace, true);
                                blocked.push(window);
                            }
                        }
                }
            }

            area.x += ext.gap_outer;
            area.y += ext.gap_outer;
            area.width -= ext.gap_outer * 2;
            area.height -= ext.gap_outer * 2;

            this.set_area(area.copy());
            this.measure(forest, ext, area, forest.on_record());
            forest.arrange(ext);

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
