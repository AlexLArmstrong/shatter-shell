import Meta from 'gi://Meta';

import type { Ext } from './extension.js';
import type { MutterWindowHandle } from './gnome/mutter_window_handle.js';

import * as arena from './arena.js';
import * as geom from './core/geom.js';
import { whole_rect, type Rect } from './core/geom.js';
import * as movement from './core/movement.js';
import { Orientation } from './core/orientation.js';
import * as Fork from './fork.js';
import { Log } from './log.js';
import * as Node from './node.js';
import { Stack, TAB_HEIGHT_UNSCALED } from './stack.js';

const { Arena } = arena;
const { Movement } = movement;

const { DOWN, UP, LEFT, RIGHT } = Movement;

export interface MoveByCursor {
    orientation: Orientation;
    swap: boolean;
}

interface MoveByKeyboard {
    src: Rect;
}

interface MoveByAuto {
    auto: 0;
}

export type MoveBy = MoveByCursor | MoveByKeyboard | MoveByAuto;

/** A request to move a window into a new location. */
interface Request {
    parent: Fork.Fork;
    rect: Rect;
}

/** A collection of forks separated into trees
 *
 * Each display on each workspace has their own unique tree. A tree is a
 * collection of starting from an uppermost fork, and branching into
 * deeply-nested sub-forks.
 *
 * Each fork represents two nodes and an orientation, whereby a node may either
 * be a window or another fork. As windows are attached to other windows,
 * forks will be dynamically removed and created to accomodate the new
 * arrangement.
 */
export class Forest implements Fork.TreeLinks {
    private readonly trees_ = new Set<Fork.Tree>();

    /** Stores window positions that have been requested. */
    requested: Map<WindowId, Request> = new Map();

    /** Stores stacks which must have their containers redrawn */
    stack_updates: Array<[Node.NodeStack, Fork.Fork]> = [];

    forks: Set<Fork.Fork> = new Set();

    /** The tab bars of the leaves that have tabs, by NodeStack.idx */
    stacks: arena.Arena<Stack> = new Arena();

    /** The leaf that holds each tiled window */
    readonly leaves = new Map<WindowId, Node.NodeLeaf>();

    parent_of(fork: Fork.Fork): Fork.Fork | null {
        return fork.parent;
    }

    /** The fork that holds the leaf of this window, if it's tiled */
    fork_of(window: WindowId): Fork.Fork | null {
        return this.leaves.get(window)?.parent ?? null;
    }

    leaf_of(window: WindowId): Node.NodeLeaf | null {
        return this.leaves.get(window) ?? null;
    }

    /** Every tiled window, with the fork that holds its leaf */
    *tiled(): Generator<[WindowId, Fork.Fork], void> {
        for (const [window, leaf] of this.leaves) {
            if (leaf.parent) yield [window, leaf.parent];
        }
    }

    /** The Stack that draws a leaf, which only one with tabs has */
    view_of(leaf: Node.NodeStack): Stack | null {
        return leaf.idx === null ? null : this.stacks.get(leaf.idx);
    }

    /**
     * The callback to execute when a window starts being tiled. It isn't called when a tiled window
     * only moves to another place in the tree.
     */
    on_attach: (window: WindowId) => void = () => {};

    /** Likewise for detachments */
    on_detach: (child: WindowId) => void = () => {};

    measure(ext: Ext, fork: Fork.Fork, area: Rect) {
        fork.measure(this.layout(ext), area);
    }

    /** Measures and arranges windows in the tree from the given fork to the specified area. */
    tile(ext: Ext, fork: Fork.Fork, area: Rect) {
        this.measure(ext, fork, area);
        this.arrange(ext);
    }

    /** Place all windows into their calculated positions. */
    arrange(ext: Ext) {
        for (const [window_id, r] of this.requested) {
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

            move_window(ext, window, r.rect, on_complete);
        }

        this.requested.clear();

        for (const [stack] of this.stack_updates.splice(0)) {
            ext.gnome_forest?.update_stack(stack);
        }
    }

    attach_fork(ext: Ext, fork: Fork.Fork, window: WindowId, is_left: boolean) {
        const node = Node.Node.window(window);

        if (is_left) {
            if (fork.right) {
                fork.right = Node.Node.fork(
                    this.create_fork(fork.left, fork.right, fork.area_of_right(ext.sizes), fork.tree),
                );
            } else {
                fork.right = fork.left;
            }

            fork.left = node;
        } else {
            if (fork.right) {
                fork.left = Node.Node.fork(
                    this.create_fork(fork.left, fork.right, fork.area_of_left(ext.sizes), fork.tree),
                );
            }

            fork.right = node;
        }

        this.on_attach(window);
    }

    attach_stack(
        ext: Ext,
        stack: Node.NodeStack,
        fork: Fork.Fork,
        new_id: WindowId,
        stack_from_left: boolean,
    ): Fork.Fork | null {
        const container = this.view_of(stack);
        if (container) {
            const window = ext.windows.get(new_id);
            if (window) {
                this.on_attach(new_id);
                Node.stack_insert(ext.tab_bars, stack, new_id, stack_from_left);

                if (window.meta.has_focus()) {
                    container.activate(new_id);
                }

                return fork;
            } else {
                Log.warn('attempted to attach window to stack that does not exist');
            }
        } else {
            Log.warn('attempted to attach to stack that does not exist');
        }

        return null;
    }

    /** Attaches a `new` window to the fork which `onto` is attached to. */
    attach_window(
        ext: Ext,
        onto_id: WindowId,
        new_id: WindowId,
        place_by: MoveBy,
        stack_from_left: boolean,
    ): Fork.Fork | null {
        /** Place a window in a fork based on where the window was originally located */
        function place_by_keyboard(fork: Fork.Fork, src: Rect, left: Rect, right: Rect) {
            const from: [number, number] = [src.x + src.width / 2, src.y + src.height / 2];

            const lside = geom.shortest_side(from, left);
            const rside = geom.shortest_side(from, right);

            if (lside < rside) fork.swap_branches();
        }

        /** By default, new attachments are positioned on the left of a branch */
        function place(place_by: MoveBy, fork: Fork.Fork, left: Rect, right: Rect) {
            if ('swap' in place_by) {
                const { orientation, swap } = place_by;
                fork.set_orientation(orientation);
                if (swap) fork.swap_branches();
            } else if ('src' in place_by) {
                place_by_keyboard(fork, place_by.src, left, right);
            }
        }

        /** Fetch two rectangles representing the inner left and right halves of a fork
         *
         * In the case of a vertical fork, the left and right halves are the top and bottom
         */
        function area_of_halves(fork: Fork.Fork): [Rect, Rect] {
            const { x, y, width, height } = fork.area;

            return fork.is_horizontal()
                ? [whole_rect(x, y, width / 2, height), whole_rect(x + width / 2, y, width / 2, height)]
                : [whole_rect(x, y, width, height / 2), whole_rect(x, y + height / 2, width, height / 2)];
        }

        /** Create a fork and place this new fork on the left branch */
        const fork_and_place_on_left = (fork: Fork.Fork): Fork.Fork | null => {
            const area = fork.area_of_left(ext.sizes);

            const new_fork = this.create_fork(fork.left, right_node, area, fork.tree);

            fork.left = Node.Node.fork(new_fork);

            const [left, right] = area_of_halves(new_fork);
            place(place_by, new_fork, left, right);

            this.on_attach(new_id);
            return fork;
        };

        /** Create a new fork and place this new fork on the right branch */
        const fork_and_place_on_right = (fork: Fork.Fork, right_branch: Node.Node): Fork.Fork | null => {
            const area = fork.area_of_right(ext.sizes);
            const new_fork = this.create_fork(right_branch, right_node, area, fork.tree);

            fork.right = Node.Node.fork(new_fork);

            const [left, right] = area_of_halves(new_fork);
            place(place_by, new_fork, left, right);

            this.on_attach(new_id);
            return fork;
        };

        const right_node = Node.Node.window(new_id);

        const fork = this.fork_of(onto_id);
        if (!fork) return null;

        if (fork.left.is_window(onto_id)) {
            if (fork.right) {
                return fork_and_place_on_left(fork);
            } else {
                fork.right = right_node;
                fork.set_ratio(fork.length() / 2);

                if ('src' in place_by) {
                    const [left, right] = area_of_halves(fork);
                    place_by_keyboard(fork, place_by.src, left, right);
                }

                this.on_attach(new_id);
                return fork;
            }
        } else if (fork.left.is_in_stack(onto_id)) {
            const stack = fork.left.inner;
            return this.attach_stack(ext, stack, fork, new_id, stack_from_left);
        } else if (fork.right) {
            if (fork.right.is_window(onto_id)) {
                return fork_and_place_on_right(fork, fork.right);
            } else if (fork.right.is_in_stack(onto_id)) {
                const stack = fork.right.inner;
                return this.attach_stack(ext, stack, fork, new_id, stack_from_left);
            }
        }

        return null;
    }

    connect_on_attach(callback: (window: WindowId) => void): this {
        this.on_attach = callback;
        return this;
    }

    connect_on_detach(callback: (child: WindowId) => void): this {
        this.on_detach = callback;
        return this;
    }

    create_fork(left: Node.Node, right: Node.Node | null, area: Rect, tree: Fork.Tree): Fork.Fork {
        const orientation = area.width > area.height ? Orientation.HORIZONTAL : Orientation.VERTICAL;
        const fork = new Fork.Fork(this, left, right, area, tree, orientation);
        this.forks.add(fork);
        return fork;
    }

    /** Moves every tree `change` pixels in from each edge, except smart-gapped ones */
    move_in(change: number) {
        for (const { root: fork } of this.trees()) {
            if (fork.smart_gapped) continue;

            fork.area.x = Math.trunc(fork.area.x + change);
            fork.area.y = Math.trunc(fork.area.y + change);
            fork.area.width = Math.trunc(fork.area.width - change * 2);
            fork.area.height = Math.trunc(fork.area.height - change * 2);
        }
    }

    /** The trees that hold a single window, with their monitors */
    *lone_trees(): Generator<[Fork.Fork, MonitorID], void> {
        for (const { root: fork } of this.trees()) {
            if (fork.right === null) yield [fork, fork.monitor];
        }
    }

    add_tree(window: WindowId, area: Rect, id: MonitorWorkspaceID): Fork.Tree {
        const manager = global.workspace_manager;
        const workspace = manager.get_workspace_by_index(id[1]) ?? manager.get_active_workspace();
        const tree = new Fork.Tree(id[0], workspace);
        tree.root = this.create_fork(Node.Node.window(window), null, area, tree);
        this.trees_.add(tree);

        return tree;
    }

    /** Removes a fork that has left the tree */
    delete_fork(fork: Fork.Fork) {
        if (!this.forks.delete(fork)) return;

        fork.detached = true;
        fork.leave();
        if (fork.is_root) this.trees_.delete(fork.tree);
    }

    /** Detaches a window from its fork, re-arranging the fork's tree as necessary */
    detach(ext: Ext, fork: Fork.Fork, window: WindowId): Fork.Fork | null {
        if (fork.detached) return null;

        // The fork which has been modified, and requires rebalancing
        let reflow_fork: Fork.Fork | null = null,
            // Stack detachments, however, need not rebalance the fork
            stack_detach = false;

        const parent = this.parent_of(fork);
        const on_left = fork.left.has(window);
        const branch = on_left ? fork.left : fork.right?.has(window) ? fork.right : null;

        if (branch?.is_leaf() && branch.inner.windows.length > 1) {
            // The window only leaves its stack, which keeps its place in the tree
            reflow_fork = fork;
            stack_detach = true;
            Node.stack_remove(ext.tab_bars, branch.inner, window);
        } else if (branch?.is_leaf()) {
            // The leaf leaves the tree along with its last window, whether or not it has tabs
            if (branch.inner.idx !== null) this.stacks.remove(branch.inner.idx)?.destroy();

            if (on_left) {
                if (parent && fork.right) {
                    reflow_fork = this.reassign_child_to_parent(fork, parent, fork.right);
                    if (!reflow_fork) return null;
                } else if (fork.right) {
                    reflow_fork = fork;
                    switch (fork.right.inner.kind) {
                        case Node.NodeKind.FORK:
                            this.reassign_children_to_parent(fork, fork.right.inner.fork);
                            break;
                        case Node.NodeKind.STACK:
                            const detached = fork.right;
                            fork.left = detached;
                            fork.right = null;
                    }
                } else {
                    this.delete_fork(fork);
                }
            } else if (parent) {
                reflow_fork = this.reassign_child_to_parent(fork, parent, fork.left);
                if (!reflow_fork) return null;
            } else {
                reflow_fork = fork;

                switch (fork.left.inner.kind) {
                    case Node.NodeKind.FORK:
                        this.reassign_children_to_parent(fork, fork.left.inner.fork);
                        break;
                    case Node.NodeKind.STACK:
                        fork.right = null;
                        break;
                }
            }
        }

        this.on_detach(window);

        if (reflow_fork && !stack_detach) {
            reflow_fork.rebalance_orientation();
        }

        return reflow_fork;
    }

    /** Creates a string representation of every fork in the world */
    fmt(ext: Ext) {
        let fmt = '';

        for (const { root: fork } of this.trees()) {
            fmt += ' ' + this.display_fork(ext, fork, 1) + '\n';
        }

        return fmt;
    }

    trees(): Iterable<Fork.Tree> {
        return this.trees_;
    }

    /**
     * Marks the trees whose workspace mutter has just removed, as it no longer has an index. Call this
     * once a workspace is removed.
     */
    note_removed_workspaces() {
        const manager = global.workspace_manager;
        const present = new Set<Meta.Workspace>();
        for (let idx = 0; idx < manager.get_n_workspaces(); idx += 1) {
            const workspace = manager.get_workspace_by_index(idx);
            if (workspace) present.add(workspace);
        }

        for (const tree of this.trees_) {
            if (!present.has(tree.workspace)) tree.workspace_removed = true;
        }
    }

    /** Finds the tree on a monitor and workspace */
    find_tree([src_mon, src_work]: MonitorWorkspaceID): Fork.Tree | null {
        for (const tree of this.trees()) {
            if (tree.monitor == src_mon && tree.is_on(src_work)) return tree;
        }

        return null;
    }

    /** Grows a sibling a fork. */
    private grow_sibling(ext: Ext, fork_c: Fork.Fork, is_left: boolean, movement: movement.Movement, crect: Rect) {
        const resize_fork = () => this.resize_fork_(ext, fork_c, crect, movement, false);

        if (fork_c.is_horizontal()) {
            if ((movement & (DOWN | UP)) != 0) {
                resize_fork();
            } else if (is_left) {
                if ((movement & RIGHT) != 0) {
                    this.readjust_fork_ratio_by_left(ext, crect.width, fork_c);
                } else {
                    resize_fork();
                }
            } else if ((movement & RIGHT) != 0) {
                resize_fork();
            } else {
                this.readjust_fork_ratio_by_right(ext, crect.width, fork_c, fork_c.area.width);
            }
        } else {
            if ((movement & (LEFT | RIGHT)) != 0) {
                resize_fork();
            } else if (is_left) {
                if ((movement & DOWN) != 0) {
                    this.readjust_fork_ratio_by_left(ext, crect.height, fork_c);
                } else {
                    resize_fork();
                }
            } else if ((movement & DOWN) != 0) {
                resize_fork();
            } else {
                this.readjust_fork_ratio_by_right(ext, crect.height, fork_c, fork_c.area.height);
            }
        }
    }

    *iter(start: Fork.Fork) {
        let fork: Fork.Fork | undefined = start.detached ? undefined : start;
        const forks = Array.from<Fork.Fork>({ length: 2 });

        while (fork) {
            {
                if (fork.left.inner.kind === Node.NodeKind.FORK) {
                    const child = fork.left.inner.fork;
                    if (!child.detached) forks.push(child);
                }
                yield fork.left;
            }

            if (fork.right) {
                if (fork.right.inner.kind === Node.NodeKind.FORK) {
                    const child = fork.right.inner.fork;
                    if (!child.detached) forks.push(child);
                }
                yield fork.right;
            }

            fork = forks.pop()!;
        }
    }

    /** Finds the largest tilable window on a monitor + workspace. */
    largest_window_on(ext: Ext, fork: Fork.Fork): MutterWindowHandle | null {
        let largest_window = null;
        let largest_size = 0;

        const window_compare = (window_id: WindowId) => {
            const window = ext.windows.get(window_id);
            if (window && window.is_tilable()) {
                const rect = window.frame();
                const size = rect.width * rect.height;
                if (size > largest_size) {
                    largest_size = size;
                    largest_window = window;
                }
            }
        };

        for (const node of this.iter(fork)) {
            if (node.is_leaf()) window_compare(node.inner.windows[0]!);
        }

        return largest_window;
    }

    /** Resize a window from a given fork based on a supplied movement. */
    resize(ext: Ext, fork_c: Fork.Fork, window_id: WindowId, movement: movement.Movement, crect: Rect) {
        const is_left = fork_c.left.has(window_id);
        if ((movement & Movement.SHRINK) != 0) {
            this.shrink_sibling(ext, fork_c, is_left, movement, crect);
        } else {
            this.grow_sibling(ext, fork_c, is_left, movement, crect);
        }
    }

    /** How this forest's trees are laid out, with the extension's sizes, and where the results go */
    layout(ext: Ext): Node.Layout {
        return {
            gap_inner: ext.sizes.gap_inner,
            gap_inner_half: ext.sizes.gap_inner_half,
            tab_height: () => ext.sizes.scale * TAB_HEIGHT_UNSCALED,
            manually_moved: () => ext.grab.window !== null || ext.gnome_tiling_mode.resizing_window,
            minimum_size: window => ext.windows.get(window)?.minimum_size() ?? [0, 0],
            place: (window, parent, rect) => this.record(window, parent, rect),
            restack: (leaf, parent) => {
                if (ext.gnome_forest) ext.gnome_forest.forest.stack_updates.push([leaf, parent]);
            },
        };
    }

    /** Moves a tree to another monitor and workspace, and lays it out in `area` there */
    migrate(ext: Ext, fork: Fork.Fork, area: Rect, monitor: MonitorID, workspace: WorkspaceID) {
        if (ext.gnome_forest && fork.is_root) {
            const primary = global.display.get_primary_monitor() === monitor;

            fork.monitor = monitor;
            fork.workspace = workspace;
            fork.on_primary_display = primary;

            const blocked = [];

            for (const child of this.iter(fork)) {
                switch (child.inner.kind) {
                    case Node.NodeKind.FORK:
                        // Its monitor and workspace are the tree's, which have already changed
                        break;
                    case Node.NodeKind.STACK:
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

            fork.set_area(geom.copy_rect(area));
            fork.measure(this.layout(ext), area);
            this.arrange(ext);

            for (const window of blocked) {
                ext.size_signals_unblock(window);
            }
        }
    }

    /** Records window movements which have been queued. */
    private record(window_id: WindowId, parent: Fork.Fork, rect: Rect) {
        this.requested.set(window_id, {
            parent: parent,
            rect: rect,
        });
    }

    /**
     * Reassigns the child of a fork to the parent
     */
    private reassign_child_to_parent(child: Fork.Fork, parent: Fork.Fork, branch: Node.Node): Fork.Fork | null {
        if (parent.detached) return null;

        if (parent.left.is_fork(child)) {
            parent.left = branch;
        } else {
            parent.right = branch;
        }

        this.delete_fork(child);

        return parent;
    }

    reassign_to_parent(child: Fork.Fork, reassign: Node.Node) {
        const p_fork = this.parent_of(child);
        if (p_fork) {
            if (!p_fork.detached) {
                if (p_fork.left.is_fork(child)) {
                    p_fork.left = reassign;
                } else {
                    p_fork.right = reassign;
                }
            }

            this.delete_fork(child);
        }
    }

    private reassign_children_to_parent(p_fork: Fork.Fork, c_fork: Fork.Fork) {
        if (c_fork.detached) {
            Log.error(`Fork(${c_fork.id}) does not exist`);
            return;
        }

        p_fork.left = c_fork.left;
        p_fork.right = c_fork.right;

        this.delete_fork(c_fork);
    }

    /** Readjusts the division of space between the left and right siblings of a fork */
    private readjust_fork_ratio_by_left(ext: Ext, left_length: number, fork: Fork.Fork) {
        fork.set_ratio(left_length).measure(this.layout(ext), fork.area);
    }

    /** Readjusts the division of space between the left and right siblings of a fork
     *
     * Determines the size of the left sibling based on the new length of the right sibling
     */
    private readjust_fork_ratio_by_right(ext: Ext, right_length: number, fork: Fork.Fork, fork_length: number) {
        this.readjust_fork_ratio_by_left(ext, fork_length - right_length, fork);
    }

    /** Resizes a fork in the direction that a movement requests */
    private resize_fork_(ext: Ext, child_fork: Fork.Fork, crect: Rect, mov: movement.Movement, shrunk: boolean) {
        let parent = this.parent_of(child_fork);
        let child = child_fork;

        if (!parent) {
            child.measure(this.layout(ext), child.area);
            return;
        }

        if (child_fork.detached) return;
        const src_node = child_fork;

        let is_left: boolean = child.left.is_fork(child_fork),
            length: number;

        while (parent !== null) {
            child = parent;
            is_left = child.left.is_fork(child_fork);

            if (geom.contains_rect(child.area, crect)) {
                if ((mov & UP) !== 0) {
                    if (shrunk) {
                        if (child.area.y + child.area.height > src_node.area.y + src_node.area.height) {
                            break;
                        }
                    } else if (!child.is_horizontal() || !is_left) {
                        break;
                    }
                } else if ((mov & DOWN) !== 0) {
                    if (shrunk) {
                        if (child.area.y < src_node.area.y) {
                            break;
                        }
                    } else if (child.is_horizontal() || is_left) {
                        break;
                    }
                } else if ((mov & LEFT) !== 0) {
                    if (shrunk) {
                        if (child.area.x + child.area.width > src_node.area.x + src_node.area.width) {
                            break;
                        }
                    } else if (!child.is_horizontal() || !is_left) {
                        break;
                    }
                } else if ((mov & RIGHT) !== 0) {
                    if (shrunk) {
                        if (child.area.x < src_node.area.x) {
                            break;
                        }
                    } else if (!child.is_horizontal() || is_left) {
                        break;
                    }
                }
            }

            child_fork = parent;
            parent = this.parent_of(child_fork);
        }

        if (child.is_horizontal()) {
            length = is_left ? crect.x + crect.width - child.area.x : crect.x - child.area.x;
        } else {
            length = is_left ? crect.y + crect.height - child.area.y : child.area.height - crect.height;
        }

        child.set_ratio(length);

        child.measure(this.layout(ext), child.area);
    }

    /** Shrinks the sibling of a fork, possibly shrinking the fork itself */
    private shrink_sibling(ext: Ext, fork_c: Fork.Fork, is_left: boolean, movement: movement.Movement, crect: Rect) {
        const resize_fork = () => this.resize_fork_(ext, fork_c, crect, movement, true);
        if (fork_c.is_horizontal()) {
            if ((movement & (DOWN | UP)) != 0) {
                resize_fork();
            } else if (is_left) {
                if ((movement & LEFT) != 0) {
                    this.readjust_fork_ratio_by_left(ext, crect.width, fork_c);
                } else {
                    resize_fork();
                }
            } else if ((movement & LEFT) != 0) {
                resize_fork();
            } else {
                this.readjust_fork_ratio_by_right(ext, crect.width, fork_c, fork_c.area.width);
            }
        } else {
            if ((movement & (LEFT | RIGHT)) != 0) {
                resize_fork();
            } else if (is_left) {
                if ((movement & UP) != 0) {
                    this.readjust_fork_ratio_by_left(ext, crect.height, fork_c);
                } else {
                    resize_fork();
                }
            } else if ((movement & UP) != 0) {
                resize_fork();
            } else {
                this.readjust_fork_ratio_by_right(ext, crect.height, fork_c, fork_c.area.height);
            }
        }
    }

    private display_branch(ext: Ext, branch: Node.Node, scope: number): string {
        switch (branch.inner.kind) {
            case Node.NodeKind.FORK:
                const fork = branch.inner.fork;
                return fork.detached ? 'Missing Fork' : this.display_fork(ext, fork, scope + 1);
            case Node.NodeKind.STACK:
                const lone = branch.lone_window();
                if (lone !== null) {
                    const window = ext.windows.get(lone);
                    const area = window ? geom.fmt(window.frame()) : 'unknown area';
                    const parent = ext.gnome_forest?.attached.get(lone);
                    return `Window(${lone}) (${area}; parent: ${parent?.id})`;
                }

                let fmt = 'Stack(';

                for (const window_id of branch.inner.windows) {
                    const window = ext.windows.get(window_id);
                    fmt += `Window(${window_id}) (${window ? geom.fmt(window.frame()) : 'unknown area'}), `;
                }

                return fmt + ')';
        }
    }

    display_fork(ext: Ext, fork: Fork.Fork, scope: number): string {
        let fmt = `Fork(${fork.id}) [${geom.fmt(fork.area)}]: {\n`;

        fmt += ' '.repeat((1 + scope) * 2) + `workspace: (${fork.workspace}),\n`;
        fmt += ' '.repeat((1 + scope) * 2) + `left: ${this.display_branch(ext, fork.left, scope)},\n`;
        fmt += ' '.repeat((1 + scope) * 2) + `parent: ${this.parent_of(fork)?.id},\n`;

        if (fork.right) {
            fmt += ' '.repeat((1 + scope) * 2) + `right: ${this.display_branch(ext, fork.right, scope)},\n`;
        } else if (!fork.is_root) {
            // Only the root fork of a tree may have one child
            fmt += ' '.repeat((1 + scope) * 2) + `right: none, which only a root fork may lack,\n`;
        }

        fmt += ' '.repeat(scope * 2) + '}';
        return fmt;
    }
}

function move_window(ext: Ext, window: MutterWindowHandle, rect: Rect, on_complete: () => void) {
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
