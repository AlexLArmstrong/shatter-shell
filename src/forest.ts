import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import type { Entity } from './ecs.js';
import type { Ext } from './extension.js';
import type { MutterWindowHandle } from './gnome/mutter_window_handle.js';

import * as arena from './arena.js';
import * as geom from './core/geom.js';
import * as movement from './core/movement.js';
import * as Ecs from './ecs.js';
import * as Fork from './fork.js';
import { Log } from './log.js';
import * as Node from './node.js';
import { Stack } from './stack.js';

const { Arena } = arena;
const { Movement } = movement;

const { DOWN, UP, LEFT, RIGHT } = Movement;

export interface MoveByCursor {
    orientation: Clutter.Orientation;
    swap: boolean;
}

interface MoveByKeyboard {
    src: Mtk.Rectangle;
}

interface MoveByAuto {
    auto: 0;
}

export type MoveBy = MoveByCursor | MoveByKeyboard | MoveByAuto;

/** A request to move a window into a new location. */
interface Request {
    parent: Entity;
    rect: Mtk.Rectangle;
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
export class Forest extends Ecs.World {
    /** Maintains a list of top-level forks. */
    toplevel: Map<string, [Entity, MonitorWorkspaceID]> = new Map();

    /** Stores window positions that have been requested. */
    requested: Map<Entity, Request> = new Map();

    /** Stores stacks which must have their containers redrawn */
    stack_updates: Array<[Node.NodeLeaf, Entity]> = [];

    /** The storage for holding all fork associations. */
    forks: Ecs.Storage<Fork.Fork> = this.register_storage();

    /** Needed when we're storing the entities in a map, because JS limitations. */
    string_reps: Ecs.Storage<string> = this.register_storage();

    stacks: arena.Arena<Stack> = new Arena();

    view_of(leaf: Node.NodeLeaf): Stack | null {
        return leaf.idx === null ? null : this.stacks.get(leaf.idx);
    }

    measure(ext: Ext, fork: Fork.Fork, area: Mtk.Rectangle) {
        fork.measure(this, ext, area, this.on_record());
    }

    /** Measures and arranges windows in the tree from the given fork to the specified area. */
    tile(ext: Ext, fork: Fork.Fork, area: Mtk.Rectangle, ignore_reset: boolean = true) {
        this.measure(ext, fork, area);
        this.arrange(ext, fork.workspace, ignore_reset);
    }

    /** Place all windows into their calculated positions. */
    arrange(ext: Ext, _workspace: WorkspaceID, _ignore_reset: boolean = false) {
        for (const [entity, r] of this.requested) {
            const window = ext.windows.get(entity);
            if (!window) continue;

            let on_complete = () => {
                if (!window.actor_exists()) return;
            };

            if (ext.gnome_tiling_mode.window) {
                if (Ecs.entity_eq(ext.gnome_tiling_mode.window, entity)) {
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

    attach_fork(ext: Ext, fork: Fork.Fork, window: MutterWindowHandle, is_left: boolean) {
        const node = Node.Node.window(window);

        if (is_left) {
            if (fork.right) {
                const new_fork = this.create_fork(
                    fork.left,
                    fork.right,
                    fork.area_of_right(ext),
                    fork.workspace,
                    fork.monitor,
                )[0];
                fork.right = Node.Node.fork(this.forks.get(new_fork)!);
            } else {
                fork.right = fork.left;
            }

            fork.left = node;
        } else {
            if (fork.right) {
                const new_fork = this.create_fork(
                    fork.left,
                    fork.right,
                    fork.area_of_left(ext),
                    fork.workspace,
                    fork.monitor,
                )[0];
                fork.left = Node.Node.fork(this.forks.get(new_fork)!);
            }

            fork.right = node;
        }
    }

    attach_stack(
        ext: Ext,
        stack: Node.NodeLeaf,
        fork: Fork.Fork,
        new_entity: Entity,
        stack_from_left: boolean,
    ): [Entity, Fork.Fork] | null {
        const container = this.view_of(stack);
        if (container) {
            const window = ext.windows.get(new_entity);
            if (window) {
                stack.insert(ext.gnome_forest, window, stack_from_left);

                if (window.meta.has_focus()) {
                    container.activate(new_entity);
                }

                return [fork.entity, fork];
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
        onto: MutterWindowHandle,
        new_window: MutterWindowHandle,
        place_by: MoveBy,
        stack_from_left: boolean,
    ): [Entity, Fork.Fork] | null {
        const onto_entity = onto.entity;
        const new_entity = new_window.entity;

        /** Place a window in a fork based on where the window was originally located */
        function place_by_keyboard(fork: Fork.Fork, src: Mtk.Rectangle, left: Mtk.Rectangle, right: Mtk.Rectangle) {
            const from: [number, number] = [src.x + src.width / 2, src.y + src.height / 2];

            const lside = geom.shortest_side(from, left);
            const rside = geom.shortest_side(from, right);

            if (lside < rside) fork.swap_branches();
        }

        /** By default, new attachments are positioned on the left of a branch */
        function place(place_by: MoveBy, fork: Fork.Fork, left: Mtk.Rectangle, right: Mtk.Rectangle) {
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
        function area_of_halves(fork: Fork.Fork): [Mtk.Rectangle, Mtk.Rectangle] {
            const { x, y, width, height } = fork.area;

            return fork.is_horizontal()
                ? [
                      new Mtk.Rectangle({ y, height, width: width / 2, x: x }),
                      new Mtk.Rectangle({ y, height, width: width / 2, x: x + width / 2 }),
                  ]
                : [
                      new Mtk.Rectangle({ x, width, height: height / 2, y: y }),
                      new Mtk.Rectangle({ x, width, height: height / 2, y: y + height / 2 }),
                  ];
        }

        /** Create a fork and place this new fork on the left branch */
        const fork_and_place_on_left = (entity: Entity, fork: Fork.Fork): [Entity, Fork.Fork] | null => {
            const area = fork.area_of_left(ext);

            const [, new_fork] = this.create_fork(fork.left, right_node, area, fork.workspace, fork.monitor);

            fork.left = Node.Node.fork(new_fork);

            const [left, right] = area_of_halves(new_fork);
            place(place_by, new_fork, left, right);

            return [entity, fork];
        };

        /** Create a new fork and place this new fork on the right branch */
        const fork_and_place_on_right = (
            entity: Entity,
            fork: Fork.Fork,
            right_branch: Node.Node,
        ): [Entity, Fork.Fork] | null => {
            const area = fork.area_of_right(ext);
            const [, new_fork] = this.create_fork(right_branch, right_node, area, fork.workspace, fork.monitor);

            fork.right = Node.Node.fork(new_fork);

            const [left, right] = area_of_halves(new_fork);
            place(place_by, new_fork, left, right);

            return [entity, fork];
        };

        const right_node = Node.Node.window(new_window);

        const fork = onto.leaf?.parent;
        if (!fork) return null;
        const entity = fork.entity;

        if (fork.left.is_window(onto_entity)) {
            if (fork.right) {
                return fork_and_place_on_left(entity, fork);
            } else {
                fork.right = right_node;
                fork.set_ratio(fork.length() / 2);

                if ('src' in place_by) {
                    const [left, right] = area_of_halves(fork);
                    place_by_keyboard(fork, place_by.src, left, right);
                }

                return [entity, fork];
            }
        } else if (fork.left.is_in_stack(onto_entity)) {
            const stack = fork.left.inner;
            return this.attach_stack(ext, stack, fork, new_entity, stack_from_left);
        } else if (fork.right) {
            if (fork.right.is_window(onto_entity)) {
                return fork_and_place_on_right(entity, fork, fork.right);
            } else if (fork.right.is_in_stack(onto_entity)) {
                const stack = fork.right.inner;
                return this.attach_stack(ext, stack, fork, new_entity, stack_from_left);
            }
        }

        return null;
    }

    /** Creates a new fork entity in the world */
    override create_entity(): Entity {
        const entity = super.create_entity();
        this.string_reps.insert(entity, `${entity}`);
        return entity;
    }

    /** Create a new fork, where the left portion is a window `Entity` */
    create_fork(
        left: Node.Node,
        right: Node.Node | null,
        area: Mtk.Rectangle,
        workspace: WorkspaceID,
        monitor: MonitorID,
    ): [Entity, Fork.Fork] {
        const entity = this.create_entity();
        const orientation = area.width > area.height ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL;
        const fork = new Fork.Fork(entity, left, right, area, workspace, monitor, orientation);
        this.forks.insert(entity, fork);
        return [entity, fork];
    }

    /** Moves every tree `change` pixels in from each edge, except smart-gapped ones */
    move_in(change: number) {
        for (const [entity] of this.toplevel.values()) {
            const fork = this.forks.get(entity);
            if (!fork || fork.smart_gapped) continue;

            fork.area.x += change;
            fork.area.y += change;
            fork.area.width -= change * 2;
            fork.area.height -= change * 2;
        }
    }

    /** The trees that hold a single window, with their monitors */
    *lone_trees(): Generator<[Fork.Fork, MonitorID], void> {
        for (const [entity, [monitor]] of this.toplevel.values()) {
            const fork = this.forks.get(entity);
            if (fork?.right === null) yield [fork, monitor];
        }
    }

    /** Create a new top level fork */
    create_toplevel(window: MutterWindowHandle, area: Mtk.Rectangle, id: MonitorWorkspaceID): [Entity, Fork.Fork] {
        const [entity, fork] = this.create_fork(Node.Node.window(window), null, area, id[1], id[0]);

        this.string_reps.with(entity, sid => {
            fork.set_toplevel(this, entity, sid, id);
        });

        return [entity, fork];
    }

    /** Deletes a fork entity from the world, performing any cleanup necessary */
    override delete_entity(entity: Entity) {
        const fork = this.forks.remove(entity);
        if (fork) {
            fork.detached = true;
            fork.leave();
        }
        if (fork && fork.is_toplevel) {
            const id = this.string_reps.get(entity);
            if (id != null) this.toplevel.delete(id);
        }

        super.delete_entity(entity);
    }

    /** Detaches an entity from the a fork, re-arranging the fork's tree as necessary */
    detach(tabs: Node.TabBars | null, fork_entity: Entity, window: Entity): [Entity, Fork.Fork] | null {
        const fork = this.forks.get(fork_entity);
        if (!fork) return null;

        // The fork which has been modified, and requires rebalancing
        let reflow_fork: [Entity, Fork.Fork] | null = null,
            // Stack detachments, however, need not rebalance the fork
            stack_detach = false;

        const parent = fork.parent?.entity ?? null;
        const on_left = fork.left.has(window);
        const branch = on_left ? fork.left : fork.right?.has(window) ? fork.right : null;

        if (branch?.is_leaf() && branch.inner.windows.length > 1) {
            reflow_fork = [fork_entity, fork];
            stack_detach = true;
            branch.inner.remove(tabs, window);
        } else if (branch?.is_leaf()) {
            if (branch.inner.idx !== null) this.stacks.remove(branch.inner.idx)?.destroy();

            if (on_left) {
                if (parent && fork.right) {
                    const pfork = this.reassign_child_to_parent(fork_entity, parent, fork.right);
                    if (!pfork) return null;
                    reflow_fork = [parent, pfork];
                } else if (fork.right) {
                    reflow_fork = [fork_entity, fork];
                    switch (fork.right.inner.kind) {
                        case Node.NodeKind.FORK:
                            this.reassign_children_to_parent(fork_entity, fork.right.inner.fork.entity, fork);
                            break;
                        case Node.NodeKind.LEAF:
                            const detached = fork.right;
                            fork.left = detached;
                            fork.right = null;
                    }
                } else {
                    this.delete_entity(fork_entity);
                }
            } else if (parent) {
                const pfork = this.reassign_child_to_parent(fork_entity, parent, fork.left);
                if (!pfork) return null;
                reflow_fork = [parent, pfork];
            } else {
                reflow_fork = [fork_entity, fork];

                switch (fork.left.inner.kind) {
                    case Node.NodeKind.FORK:
                        this.reassign_children_to_parent(fork_entity, fork.left.inner.fork.entity, fork);
                        break;
                    case Node.NodeKind.LEAF:
                        fork.right = null;
                        break;
                }
            }
        }

        if (reflow_fork && !stack_detach) {
            reflow_fork[1].rebalance_orientation();
        }

        return reflow_fork;
    }

    /** Finds the top level fork associated with the given entity. */
    find_toplevel([src_mon, src_work]: MonitorWorkspaceID): Entity | null {
        for (const [entity, fork] of this.forks.iter()) {
            if (!fork.is_toplevel) continue;
            const { monitor, workspace } = fork;
            if (monitor == src_mon && workspace == src_work) {
                return entity;
            }
        }

        return null;
    }

    /** Grows a sibling a fork. */
    private grow_sibling(
        ext: Ext,
        fork_e: Entity,
        fork_c: Fork.Fork,
        is_left: boolean,
        movement: movement.Movement,
        crect: Mtk.Rectangle,
    ) {
        const resize_fork = () => this.resize_fork_(ext, fork_e, crect, movement, false);

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

    /** Walks the tree starting at a given fork entity. */
    *iter(entity: Entity) {
        let fork = this.forks.get(entity);
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
    largest_window_on(ext: Ext, entity: Entity): MutterWindowHandle | null {
        let largest_window = null;
        let largest_size = 0;

        const window_compare = (window: MutterWindowHandle) => {
            if (window.is_tilable()) {
                const rect = window.frame();
                const size = rect.width * rect.height;
                if (size > largest_size) {
                    largest_size = size;
                    largest_window = window;
                }
            }
        };

        for (const node of this.iter(entity)) {
            if (node.is_leaf()) window_compare(node.inner.windows[0]!);
        }

        return largest_window;
    }

    /** Resize a window from a given fork based on a supplied movement. */
    resize(
        ext: Ext,
        fork_e: Entity,
        fork_c: Fork.Fork,
        win_e: Entity,
        movement: movement.Movement,
        crect: Mtk.Rectangle,
    ) {
        const is_left = fork_c.left.has(win_e);
        if ((movement & Movement.SHRINK) != 0) {
            this.shrink_sibling(ext, fork_e, fork_c, is_left, movement, crect);
        } else {
            this.grow_sibling(ext, fork_e, fork_c, is_left, movement, crect);
        }
    }

    /** Higher order function which forwards record events to our record method. */
    on_record(): (entity: Entity, parent: Entity, rect: Mtk.Rectangle) => void {
        return (e, p, a) => this.record(e, p, a);
    }

    /** Records window movements which have been queued. */
    private record(entity: Entity, parent: Entity, rect: Mtk.Rectangle) {
        this.requested.set(entity, {
            parent: parent,
            rect: rect,
        });
    }

    /**
     * Reassigns the child of a fork to the parent
     */
    private reassign_child_to_parent(child_entity: Entity, parent_entity: Entity, branch: Node.Node): Fork.Fork | null {
        const parent = this.forks.get(parent_entity);

        if (parent) {
            if (parent.left.is_fork(child_entity)) {
                parent.left = branch;
            } else {
                parent.right = branch;
            }

            this.delete_entity(child_entity);
        }

        return parent;
    }

    reassign_to_parent(child: Fork.Fork, reassign: Node.Node) {
        const p_fork = child.parent;
        if (p_fork) {
            if (p_fork.left.is_fork(child.entity)) {
                p_fork.left = reassign;
            } else {
                p_fork.right = reassign;
            }

            this.delete_entity(child.entity);
        }
    }

    /**
     * Reassigns children of the child entity to the parent entity
     *
     * Each fork has a left and optional right child entity
     */
    private reassign_children_to_parent(parent_entity: Entity, child_entity: Entity, p_fork: Fork.Fork) {
        const c_fork = this.forks.get(child_entity);

        if (c_fork) {
            p_fork.left = c_fork.left;
            p_fork.right = c_fork.right;

            this.delete_entity(child_entity);
        } else {
            Log.error(`Fork(${child_entity}) does not exist`);
        }
    }

    /** Readjusts the division of space between the left and right siblings of a fork */
    private readjust_fork_ratio_by_left(ext: Ext, left_length: number, fork: Fork.Fork) {
        fork.set_ratio(left_length).measure(this, ext, fork.area, this.on_record());
    }

    /** Readjusts the division of space between the left and right siblings of a fork
     *
     * Determines the size of the left sibling based on the new length of the right sibling
     */
    private readjust_fork_ratio_by_right(ext: Ext, right_length: number, fork: Fork.Fork, fork_length: number) {
        this.readjust_fork_ratio_by_left(ext, fork_length - right_length, fork);
    }

    /** Resizes a fork in the direction that a movement requests */
    private resize_fork_(ext: Ext, child_e: Entity, crect: Mtk.Rectangle, mov: movement.Movement, shrunk: boolean) {
        let child = this.forks.get(child_e)!;
        let parent = child.parent;

        if (!parent) {
            child.measure(this, ext, child.area, this.on_record());
            return;
        }

        const src_node = this.forks.get(child_e);
        if (!src_node) return;

        let is_left: boolean = child.left.is_fork(child_e),
            length: number;

        while (parent !== null) {
            child = parent;
            is_left = child.left.is_fork(child_e);

            if (child.area.contains_rect(crect)) {
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

            child_e = child.entity;
            parent = child.parent;
        }

        if (child.is_horizontal()) {
            length = is_left ? crect.x + crect.width - child.area.x : crect.x - child.area.x;
        } else {
            length = is_left ? crect.y + crect.height - child.area.y : child.area.height - crect.height;
        }

        child.set_ratio(length);

        child.measure(this, ext, child.area, this.on_record());
    }

    /** Shrinks the sibling of a fork, possibly shrinking the fork itself */
    private shrink_sibling(
        ext: Ext,
        fork_e: Entity,
        fork_c: Fork.Fork,
        is_left: boolean,
        movement: movement.Movement,
        crect: Mtk.Rectangle,
    ) {
        const resize_fork = () => this.resize_fork_(ext, fork_e, crect, movement, true);
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
}

function move_window(ext: Ext, window: MutterWindowHandle, rect: Mtk.Rectangle, on_complete: () => void) {
    if (!(window.meta instanceof Meta.Window)) {
        Log.error(`attempting to a window entity in a tree which lacks a Meta.Window`);
        return;
    }

    const actor = window.meta.get_compositor_private<Meta.WindowActor | null>();

    if (!actor) {
        Log.warn(`Window(${window.entity}) does not have an actor, and therefore cannot be moved`);
        return;
    }

    ext.size_signals_block(window);
    window.move(rect, () => {
        on_complete();
        ext.size_signals_unblock(window);
    });
}
