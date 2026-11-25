import type { LayoutSizes } from './layout_sizes.js';

import * as arena from './arena.js';
import * as Fork from './fork.js';
import * as geom from './geom.js';
import { whole_rect, type Rect } from './geom.js';
import * as movement from './movement.js';
import * as Node from './node.js';
import { Orientation } from './orientation.js';

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
/** The widget that draws the tab bar of a tabbed leaf */
export interface TabBar {
    /** Shows the tab of this window as the active one */
    activate(window: WindowId): void;
    destroy(): void;
}

/** What the forest needs to know about the windows that it tiles */
export interface WindowStates {
    /** Whether the window is managed */
    has(window: WindowId): boolean;

    has_focus(window: WindowId): boolean;
}

/** What laying out a tree needs from outside of the forest */
export type LayoutSource = Omit<Node.Layout, 'place' | 'restack'>;

export class Forest<B extends TabBar = TabBar> implements Fork.TreeLinks {
    constructor(
        private readonly workspaces: Fork.WorkspaceList,
        private readonly tabs: Node.TabBars,
        private readonly sizes: LayoutSizes,
        private readonly windows: WindowStates,
        private readonly warn: (message: string) => void,
    ) {}

    private readonly trees_ = new Set<Fork.Tree>();

    /** Stores window positions that have been requested. */
    requested: Map<WindowId, Request> = new Map();

    /** Stores stacks which must have their containers redrawn */
    stack_updates: Array<[Node.NodeStack, Fork.Fork]> = [];

    forks: Set<Fork.Fork> = new Set();

    /** The tab bars of the leaves that have tabs, by NodeStack.idx */
    stacks: arena.Arena<B> = new Arena();

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

    /** The tab bar that draws a leaf, which only one with tabs has */
    view_of(leaf: Node.NodeStack): B | null {
        return leaf.idx === null ? null : this.stacks.get(leaf.idx);
    }

    /**
     * The callback to execute when a window starts being tiled. It isn't called when a tiled window
     * only moves to another place in the tree.
     */
    on_attach: (window: WindowId) => void = () => {};

    /** Likewise for detachments */
    on_detach: (child: WindowId) => void = () => {};

    attach_fork(fork: Fork.Fork, window: WindowId, is_left: boolean) {
        const node = Node.Node.window(window);

        if (is_left) {
            if (fork.right) {
                fork.right = Node.Node.fork(
                    this.create_fork(fork.left, fork.right, fork.area_of_right(this.sizes), fork.tree),
                );
            } else {
                fork.right = fork.left;
            }

            fork.left = node;
        } else {
            if (fork.right) {
                fork.left = Node.Node.fork(
                    this.create_fork(fork.left, fork.right, fork.area_of_left(this.sizes), fork.tree),
                );
            }

            fork.right = node;
        }

        this.on_attach(window);
    }

    attach_stack(stack: Node.NodeStack, fork: Fork.Fork, new_id: WindowId, stack_from_left: boolean): Fork.Fork | null {
        const container = this.view_of(stack);
        if (container) {
            if (this.windows.has(new_id)) {
                this.on_attach(new_id);
                Node.stack_insert(this.tabs, stack, new_id, stack_from_left);

                if (this.windows.has_focus(new_id)) {
                    container.activate(new_id);
                }

                return fork;
            } else {
                this.warn('attempted to attach window to stack that does not exist');
            }
        } else {
            this.warn('attempted to attach to stack that does not exist');
        }

        return null;
    }

    /** Attaches a `new` window to the fork which `onto` is attached to. */
    attach_window(onto_id: WindowId, new_id: WindowId, place_by: MoveBy, stack_from_left: boolean): Fork.Fork | null {
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
            const area = fork.area_of_left(this.sizes);

            const new_fork = this.create_fork(fork.left, right_node, area, fork.tree);

            fork.left = Node.Node.fork(new_fork);

            const [left, right] = area_of_halves(new_fork);
            place(place_by, new_fork, left, right);

            this.on_attach(new_id);
            return fork;
        };

        /** Create a new fork and place this new fork on the right branch */
        const fork_and_place_on_right = (fork: Fork.Fork, right_branch: Node.Node): Fork.Fork | null => {
            const area = fork.area_of_right(this.sizes);
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
            return this.attach_stack(stack, fork, new_id, stack_from_left);
        } else if (fork.right) {
            if (fork.right.is_window(onto_id)) {
                return fork_and_place_on_right(fork, fork.right);
            } else if (fork.right.is_in_stack(onto_id)) {
                const stack = fork.right.inner;
                return this.attach_stack(stack, fork, new_id, stack_from_left);
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

    add_tree(window: WindowId, area: Rect, id: MonitorWorkspaceID, on_primary: boolean): Fork.Tree {
        const workspace = this.workspaces.at(id[1]) ?? this.workspaces.active();
        const tree = new Fork.Tree(id[0], workspace, on_primary, this.workspaces);
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
    detach(fork: Fork.Fork, window: WindowId): Fork.Fork | null {
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
            Node.stack_remove(this.tabs, branch.inner, window);
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

    trees(): Iterable<Fork.Tree> {
        return this.trees_;
    }

    /** Finds the tree on a monitor and workspace */
    find_tree([src_mon, src_work]: MonitorWorkspaceID): Fork.Tree | null {
        for (const tree of this.trees()) {
            if (tree.monitor == src_mon && tree.is_on(src_work)) return tree;
        }

        return null;
    }

    /** Grows a sibling a fork. */
    private grow_sibling(
        layout: Node.Layout,
        fork_c: Fork.Fork,
        is_left: boolean,
        movement: movement.Movement,
        crect: Rect,
    ) {
        const resize_fork = () => this.resize_fork_(layout, fork_c, crect, movement, false);

        if (fork_c.is_horizontal()) {
            if ((movement & (DOWN | UP)) != 0) {
                resize_fork();
            } else if (is_left) {
                if ((movement & RIGHT) != 0) {
                    this.readjust_fork_ratio_by_left(layout, crect.width, fork_c);
                } else {
                    resize_fork();
                }
            } else if ((movement & RIGHT) != 0) {
                resize_fork();
            } else {
                this.readjust_fork_ratio_by_right(layout, crect.width, fork_c, fork_c.area.width);
            }
        } else {
            if ((movement & (LEFT | RIGHT)) != 0) {
                resize_fork();
            } else if (is_left) {
                if ((movement & DOWN) != 0) {
                    this.readjust_fork_ratio_by_left(layout, crect.height, fork_c);
                } else {
                    resize_fork();
                }
            } else if ((movement & DOWN) != 0) {
                resize_fork();
            } else {
                this.readjust_fork_ratio_by_right(layout, crect.height, fork_c, fork_c.area.height);
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

    /** Resize a window from a given fork based on a supplied movement. */
    resize(layout: Node.Layout, fork_c: Fork.Fork, window_id: WindowId, movement: movement.Movement, crect: Rect) {
        const is_left = fork_c.left.has(window_id);
        if ((movement & Movement.SHRINK) != 0) {
            this.shrink_sibling(layout, fork_c, is_left, movement, crect);
        } else {
            this.grow_sibling(layout, fork_c, is_left, movement, crect);
        }
    }

    /** How this forest's trees are laid out, with the extension's sizes, and where the results go */
    layout(source: LayoutSource): Node.Layout {
        return {
            gap_inner: source.gap_inner,
            gap_inner_half: source.gap_inner_half,
            tab_height: () => source.tab_height(),
            manually_moved: () => source.manually_moved(),
            minimum_size: window => source.minimum_size(window),
            place: (window, parent, rect) => this.record(window, parent, rect),
            restack: (leaf, parent) => this.stack_updates.push([leaf, parent]),
        };
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
            this.warn(`Fork(${c_fork.id}) does not exist`);
            return;
        }

        p_fork.left = c_fork.left;
        p_fork.right = c_fork.right;

        this.delete_fork(c_fork);
    }

    /** Readjusts the division of space between the left and right siblings of a fork */
    private readjust_fork_ratio_by_left(layout: Node.Layout, left_length: number, fork: Fork.Fork) {
        fork.set_ratio(left_length).measure(layout, fork.area);
    }

    /** Readjusts the division of space between the left and right siblings of a fork
     *
     * Determines the size of the left sibling based on the new length of the right sibling
     */
    private readjust_fork_ratio_by_right(
        layout: Node.Layout,
        right_length: number,
        fork: Fork.Fork,
        fork_length: number,
    ) {
        this.readjust_fork_ratio_by_left(layout, fork_length - right_length, fork);
    }

    /** Resizes a fork in the direction that a movement requests */
    private resize_fork_(
        layout: Node.Layout,
        child_fork: Fork.Fork,
        crect: Rect,
        mov: movement.Movement,
        shrunk: boolean,
    ) {
        let parent = this.parent_of(child_fork);
        let child = child_fork;

        if (!parent) {
            child.measure(layout, child.area);
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

        child.measure(layout, child.area);
    }

    /** Shrinks the sibling of a fork, possibly shrinking the fork itself */
    private shrink_sibling(
        layout: Node.Layout,
        fork_c: Fork.Fork,
        is_left: boolean,
        movement: movement.Movement,
        crect: Rect,
    ) {
        const resize_fork = () => this.resize_fork_(layout, fork_c, crect, movement, true);
        if (fork_c.is_horizontal()) {
            if ((movement & (DOWN | UP)) != 0) {
                resize_fork();
            } else if (is_left) {
                if ((movement & LEFT) != 0) {
                    this.readjust_fork_ratio_by_left(layout, crect.width, fork_c);
                } else {
                    resize_fork();
                }
            } else if ((movement & LEFT) != 0) {
                resize_fork();
            } else {
                this.readjust_fork_ratio_by_right(layout, crect.width, fork_c, fork_c.area.width);
            }
        } else {
            if ((movement & (LEFT | RIGHT)) != 0) {
                resize_fork();
            } else if (is_left) {
                if ((movement & UP) != 0) {
                    this.readjust_fork_ratio_by_left(layout, crect.height, fork_c);
                } else {
                    resize_fork();
                }
            } else if ((movement & UP) != 0) {
                resize_fork();
            } else {
                this.readjust_fork_ratio_by_right(layout, crect.height, fork_c, fork_c.area.height);
            }
        }
    }
}
