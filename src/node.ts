import Mtk from 'gi://Mtk';

import type { Entity } from './ecs.js';
import type { Ext } from './extension.js';
import type { Forest } from './forest.js';

import * as Ecs from './ecs.js';
import { TAB_HEIGHT_UNSCALED } from './stack.js';

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
}

/** Identifies this node as a window */
export interface NodeWindow {
    kind: NodeKind.WINDOW;
    entity: Entity;
}

/**
 * A leaf of the tree that holds windows, and shows one of them at a time. This is everything there is
 * to know about a stack: its Stack in Forest.stacks only draws it, with a tab bar.
 */
export interface NodeStack {
    kind: NodeKind.STACK;
    /** The index of the Stack in Forest.stacks that draws this leaf */
    idx: number;
    /** The windows, in the order of their tabs */
    entities: Array<Entity>;
    /** The window that is shown. It's always one of the entities while there are any. */
    active: Entity;
    /** The window that was shown before, which is shown again when the active one leaves */
    prev_active: Entity | null;
    rect: Mtk.Rectangle | null;
}

/*
 * A stack's windows, their order, and which of them is active only change through the functions
 * below. Each one changes the tree, which is the only record of them, and then has the stack drawn
 * again before returning, so that what is drawn is never behind the tree.
 */

/** Draws the stack again from the tree */
function sync_tabs(ext: Ext, node: NodeStack) {
    ext.auto_tiler?.update_stack(ext, node);
}

export function stack_find(node: NodeStack, entity: Entity) {
    const idx = node.entities.findIndex(other => Ecs.entity_eq(entity, other));
    return idx === -1 ? null : idx;
}

/** Shows this window of the stack, and remembers the one that was shown before */
export function stack_activate(ext: Ext, node: NodeStack, entity: Entity) {
    if (stack_find(node, entity) === null) return;

    if (!Ecs.entity_eq(node.active, entity)) {
        node.prev_active = node.active;
        node.active = entity;
    }

    sync_tabs(ext, node);
}

/** Adds a window at either end of a stack, behind its active window */
export function stack_insert(ext: Ext, node: NodeStack, entity: Entity, at_end: boolean) {
    if (at_end) {
        node.entities.push(entity);
    } else {
        node.entities.unshift(entity);
    }

    sync_tabs(ext, node);
}

/**
 * Removes a window from a stack, returning where it was. If it was the active one, the previously
 * active window takes over if it's still there, and otherwise the one that is now in its place.
 */
export function stack_remove(ext: Ext, node: NodeStack, entity: Entity): number | null {
    const idx = stack_find(node, entity);
    if (idx === null) return null;

    node.entities.splice(idx, 1);

    if (node.prev_active && Ecs.entity_eq(node.prev_active, entity)) node.prev_active = null;

    if (Ecs.entity_eq(node.active, entity)) {
        const next = node.prev_active ?? node.entities[Math.min(idx, node.entities.length - 1)];
        if (next) node.active = next;
        node.prev_active = null;
    }

    sync_tabs(ext, node);
    return idx;
}

/**
 * Puts another window in the place of one in a stack, such as when swapping windows. It also takes
 * over whether that window was active, so that a swap never shows an inactive tab, not even between
 * replacing the two windows.
 */
export function stack_replace(ext: Ext, node: NodeStack, old: Entity, entity: Entity) {
    const idx = stack_find(node, old);
    if (idx === null) return;

    node.entities[idx] = entity;
    if (Ecs.entity_eq(node.active, old)) node.active = entity;
    if (node.prev_active && Ecs.entity_eq(node.prev_active, old)) node.prev_active = entity;

    sync_tabs(ext, node);
}

function stack_swap(ext: Ext, node: NodeStack, from: number, to: number) {
    const a = node.entities[from];
    const b = node.entities[to];
    if (a === undefined || b === undefined) return;

    node.entities[from] = b;
    node.entities[to] = a;
    sync_tabs(ext, node);
}

/** Move the window in a stack to the left, and detach if it it as the end. */
export function stack_move_left(ext: Ext, node: NodeStack, entity: Entity): boolean {
    const idx = stack_find(node, entity);
    if (idx === null) return false;

    if (idx === 0) {
        stack_remove(ext, node, entity);
        return false;
    }

    stack_swap(ext, node, idx - 1, idx);
    return true;
}

/** Move the window in a stack to the right, and detach if it is at the end. */
export function stack_move_right(ext: Ext, node: NodeStack, entity: Entity): boolean {
    const idx = stack_find(node, entity);
    if (idx === null) return false;

    if (idx === node.entities.length - 1) {
        stack_remove(ext, node, entity);
        return false;
    }

    stack_swap(ext, node, idx + 1, idx);
    return true;
}

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
        return new Node({ kind: NodeKind.FORK, entity });
    }

    /** Create the window variant of a `Node` */
    static window(entity: Entity): Node<NodeWindow> {
        return new Node({ kind: NodeKind.WINDOW, entity });
    }

    static stacked(window: Entity, idx: number): Node<NodeStack> {
        return new Node({
            kind: NodeKind.STACK,
            entities: [window],
            active: window,
            prev_active: null,
            idx,
            rect: null,
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
                const tab_height = ext.dpi * TAB_HEIGHT_UNSCALED;

                this.inner.rect = area.copy();
                this.inner.rect.y += tab_height;
                this.inner.rect.height -= tab_height;

                for (const entity of this.inner.entities) {
                    record(entity, parent, this.inner.rect);
                }

                if (ext.auto_tiler) {
                    ext.auto_tiler.forest.stack_updates.push([this.inner, parent]);
                }
        }
    }
}
