import Mtk from 'gi://Mtk';

import type { Entity } from './ecs.js';
import type { Ext } from './extension.js';
import type { Forest } from './forest.js';

import * as Ecs from './ecs.js';
import { TAB_HEIGHT_UNSCALED } from './stack.js';

/**
 * A node is either a fork, or a stack of windows, which is every leaf of the tree. A window on its own
 * is a stack of one that has no tab bar.
 */
export enum NodeKind {
    FORK = 1,
    STACK = 3,
}

/** Fetch the string representation of this value */
function node_kind_as_string(kind: NodeKind): string {
    switch (kind) {
        case NodeKind.FORK:
            return 'NodeKind.FORK';
        case NodeKind.STACK:
            return 'NodeKind.STACK';
    }
}

/** Identifies this node as a fork */
export interface NodeFork {
    kind: NodeKind.FORK;
    entity: Entity;
}

/**
 * A leaf of the tree, which holds windows and shows one of them at a time. This is everything there
 * is to know about it: a tabbed leaf also has a Stack in Forest.stacks, which only draws it.
 *
 * A leaf without tabs holds exactly one window, and is what used to be a window node.
 */
export interface NodeStack {
    kind: NodeKind.STACK;
    /** Whether the leaf has a tab bar, and so can hold more than one window */
    tabbed: boolean;
    /** The index of the Stack in Forest.stacks that draws this leaf, which only a tabbed one has */
    idx: number | null;
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

export type NodeADT = NodeFork | NodeStack;

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

    /** Creates a leaf of one window, without tabs */
    static window(entity: Entity): Node<NodeStack> {
        return new Node({
            kind: NodeKind.STACK,
            tabbed: false,
            idx: null,
            entities: [entity],
            active: entity,
            prev_active: null,
            rect: null,
        });
    }

    /** Generates a string representation of the this value. */
    display(): string {
        let fmt = `Node{\n    kind: ${node_kind_as_string(this.inner.kind)},\n`;
        switch (this.inner.kind) {
            case NodeKind.FORK:
                fmt += `    entity: (${this.inner.entity})\n  }`;
                break;
            case NodeKind.STACK:
                fmt += `    tabbed: ${this.inner.tabbed}, entities: ${this.inner.entities}\n  }`;
                break;
        }
        return fmt;
    }

    /** Whether this is a leaf, which every node but a fork is */
    is_leaf(): this is Node<NodeStack> {
        return this.inner.kind === NodeKind.STACK;
    }

    /** Whether this is a leaf that holds the window, with tabs or without */
    has(entity: Entity): this is Node<NodeStack> {
        return this.is_leaf() && this.inner.entities.some(other => Ecs.entity_eq(entity, other));
    }

    /** Whether this is a leaf with tabs that holds the window */
    is_in_stack(entity: Entity): this is Node<NodeStack> {
        return this.has(entity) && this.inner.tabbed;
    }

    /** Asks if this fork is the fork we are looking for */
    is_fork(entity: Entity): boolean {
        return this.inner.kind === NodeKind.FORK && Ecs.entity_eq(this.inner.entity, entity);
    }

    /** Whether this is a leaf without tabs, which holds only this window */
    is_window(entity: Entity): this is Node<NodeStack> {
        return this.has(entity) && !this.inner.tabbed;
    }

    /** The window of a leaf without tabs, or null for any other node */
    lone_window(): Entity | null {
        return this.is_leaf() && !this.inner.tabbed ? (this.inner.entities[0] ?? null) : null;
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
            case NodeKind.STACK:
                // Only a tabbed leaf leaves room for its tab bar
                this.inner.rect = area.copy();
                if (this.inner.tabbed) {
                    const tab_height = ext.dpi * TAB_HEIGHT_UNSCALED;
                    this.inner.rect.y += tab_height;
                    this.inner.rect.height -= tab_height;
                }

                for (const entity of this.inner.entities) {
                    record(entity, parent, this.inner.tabbed ? this.inner.rect : this.inner.rect.copy());
                }

                if (this.inner.tabbed && ext.auto_tiler) {
                    ext.auto_tiler.forest.stack_updates.push([this.inner, parent]);
                }
        }
    }
}
