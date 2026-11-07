import Mtk from 'gi://Mtk';

import type { Entity } from './ecs.js';
import type { Ext } from './extension.js';
import type { Forest } from './forest.js';
import type { Fork } from './fork.js';

import * as Ecs from './ecs.js';
import { MutterWindowHandle } from './gnome/mutter_window_handle.js';
import { TAB_HEIGHT_UNSCALED, type Stack } from './stack.js';

/** A node is either a fork, a window, or a stack. */
export enum NodeKind {
    FORK = 1,
    WINDOW = 2,
    STACK = 3,
}

/** Fetch the string representation of this value */
function node_kind_as_string(kind: NodeKind): string {
    switch (kind) {
        case NodeKind.FORK:
            return 'NodeKind.FORK';
        case NodeKind.WINDOW:
            return 'NodeKind.WINDOW';
        case NodeKind.STACK:
            return 'NodeKind.STACK';
    }
}

/** Identifies this node as a fork */
export interface NodeFork {
    kind: NodeKind.FORK;
    entity: Entity;
    /** The fork whose branch this is, kept by {@link Fork} */
    parent: Fork | null;
}

/** Identifies this node as a window */
export interface NodeWindow {
    kind: NodeKind.WINDOW;
    entity: Entity;
    /** The fork whose branch this is, kept by {@link Fork} */
    parent: Fork | null;
}

export interface NodeStack {
    kind: NodeKind.STACK;
    idx: number;
    entities: Array<Entity>;
    rect: Mtk.Rectangle | null;
    /** The fork whose branch this is, kept by {@link Fork} */
    parent: Fork | null;
}

/** Puts a window into the stack's leaf, at its front or its back */
export function stack_add(node: NodeStack, window: Entity, front = false) {
    if (front) {
        node.entities.unshift(window);
    } else {
        node.entities.push(window);
    }
    node.parent?.hold_window(node, window);
}

/** Puts a window in place of the one at `idx` in the stack's leaf */
export function stack_set(node: NodeStack, idx: number, window: Entity) {
    const previous = node.entities[idx];
    node.entities[idx] = window;
    node.parent?.hold_window(node, window);
    if (previous) node.parent?.let_go_window(node, previous);
}

/** Takes the window at `idx` out of the stack's leaf */
function stack_take(node: NodeStack, idx: number) {
    const [window] = node.entities.splice(idx, 1);
    if (window) node.parent?.let_go_window(node, window);
}

/** Puts a window in place of the one in the leaf */
export function window_set(node: NodeWindow, window: Entity) {
    const previous = node.entity;
    node.entity = window;
    node.parent?.hold_window(node, window);
    node.parent?.let_go_window(node, previous);
}

function stack_detach(node: NodeStack, stack: Stack, idx: number) {
    stack_take(node, idx);
    stack.remove_by_pos(idx);
}

export function stack_find(node: NodeStack, entity: Entity) {
    let idx = 0;
    while (idx < node.entities.length) {
        if (Ecs.entity_eq(entity, node.entities[idx]!)) {
            return idx;
        }
        idx += 1;
    }

    return null;
}

/** Move the window in a stack to the left, and detach if it it as the end. */
export function stack_move_left(ext: Ext, forest: Forest, node: NodeStack, entity: Entity): boolean {
    const stack = forest.stacks.get(node.idx);
    if (!stack) return false;

    let idx = 0;
    for (const cmp of node.entities) {
        if (Ecs.entity_eq(cmp, entity)) {
            if (idx === 0) {
                // Remove the window from the stack
                stack_detach(node, stack, 0);
                return false;
            } else {
                // Swap tabs in the stack
                stack_swap(node, idx - 1, idx);
                stack.active_id -= 1;
                ext.gnome_forest?.update_stack(node);
                return true;
            }
        }

        idx += 1;
    }

    return false;
}

/** Move the window in a stack to the right, and detach if it is at the end. */
export function stack_move_right(ext: Ext, forest: Forest, node: NodeStack, entity: Entity): boolean {
    const stack = forest.stacks.get(node.idx);
    if (!stack) return false;

    let moved = false;
    let idx = 0;
    const max = node.entities.length - 1;
    for (const cmp of node.entities) {
        if (Ecs.entity_eq(cmp, entity)) {
            if (idx === max) {
                stack_detach(node, stack, idx);
                moved = false;
            } else {
                stack_swap(node, idx + 1, idx);
                stack.active_id += 1;
                ext.gnome_forest?.update_stack(node);
                moved = true;
            }
            break;
        }

        idx += 1;
    }

    return moved;
}

export function stack_replace(ext: Ext, node: NodeStack, window: MutterWindowHandle) {
    if (!ext.gnome_forest) return;

    const stack = ext.gnome_forest.forest.stacks.get(node.idx);
    if (!stack) return;

    stack.replace(window);
}

/** Removes a window from a stack */
export function stack_remove(forest: Forest, node: NodeStack, entity: Entity) {
    const stack = forest.stacks.get(node.idx);
    if (!stack) return null;
    const idx = stack.remove_tab(entity);
    if (idx !== null) stack_take(node, idx);
    return idx;
}

function stack_swap(node: NodeStack, from: number, to: number) {
    const tmp = node.entities[from];
    node.entities[from] = node.entities[to]!;
    node.entities[to] = tmp!;
}

/** A leaf of the tree, which holds one window or a stack of them */
export type NodeLeaf = NodeWindow | NodeStack;

export type NodeADT = NodeFork | NodeWindow | NodeStack;

/** A tiling node may either refer to a window entity, or another fork entity */
export class Node<T extends NodeADT = NodeADT> {
    /** The actual data for this node */
    inner: T;

    constructor(inner: T) {
        this.inner = inner;
    }

    /** Create a fork variant of a `Node` */
    static fork(entity: Entity): Node<NodeFork> {
        return new Node({ kind: NodeKind.FORK, entity, parent: null });
    }

    /** Create the window variant of a `Node` */
    static window(entity: Entity): Node<NodeWindow> {
        return new Node({ kind: NodeKind.WINDOW, entity, parent: null });
    }

    static stacked(window: Entity, idx: number): Node<NodeStack> {
        return new Node({
            kind: NodeKind.STACK,
            entities: [window],
            idx,
            rect: null,
            parent: null,
        });
    }

    /** Generates a string representation of the this value. */
    display(): string {
        let fmt = `Node{\n    kind: ${node_kind_as_string(this.inner.kind)},\n`;
        switch (this.inner.kind) {
            case NodeKind.FORK:
            case NodeKind.WINDOW:
                fmt += `    entity: (${this.inner.entity})\n  }`;
                break;
            case NodeKind.STACK:
                fmt += `    entities: ${this.inner.entities}\n  }`;
                break;
        }
        return fmt;
    }

    /** Whether this is a leaf that holds the window, either on its own or in a stack */
    has(entity: Entity): boolean {
        return this.is_window(entity) || this.is_in_stack(entity);
    }

    /** Check if the entity exists as a child of this stack */
    is_in_stack(entity: Entity): this is Node<T> & { inner: NodeStack } {
        if (this.inner.kind === NodeKind.STACK) {
            for (const compare of this.inner.entities) {
                if (Ecs.entity_eq(entity, compare)) return true;
            }
        }

        return false;
    }

    /** Asks if this fork is the fork we are looking for */
    is_fork(entity: Entity): boolean {
        return this.inner.kind === NodeKind.FORK && Ecs.entity_eq(this.inner.entity, entity);
    }

    /** Asks if this window is the window we are looking for */
    is_window(entity: Entity): boolean {
        return this.inner.kind === NodeKind.WINDOW && Ecs.entity_eq(this.inner.entity, entity);
    }

    /** Calculates the future arrangement of windows in this node */
    measure(
        tiler: Forest,
        ext: Ext,
        parent: Entity,
        area: Mtk.Rectangle,
        record: (win: Entity, parent: Entity, area: Mtk.Rectangle) => void,
    ) {
        switch (this.inner.kind) {
            case NodeKind.FORK:
                const fork = tiler.forks.get(this.inner.entity);
                if (fork) {
                    fork.measure(tiler, ext, area, record);
                }

                break;
            case NodeKind.WINDOW:
                record(this.inner.entity, parent, area.copy());
                break;
            case NodeKind.STACK:
                const tab_height = ext.sizes.scale * TAB_HEIGHT_UNSCALED;

                this.inner.rect = area.copy();
                this.inner.rect.y += tab_height;
                this.inner.rect.height -= tab_height;

                for (const entity of this.inner.entities) {
                    record(entity, parent, this.inner.rect);
                }

                if (ext.gnome_forest) {
                    ext.gnome_forest.forest.stack_updates.push([this.inner, parent]);
                }
        }
    }
}
