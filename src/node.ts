import Mtk from 'gi://Mtk';

import type { Entity } from './ecs.js';
import type { Ext } from './extension.js';
import type { Forest } from './forest.js';
import type { Fork } from './fork.js';

import * as Ecs from './ecs.js';
import { MutterWindowHandle } from './gnome/mutter_window_handle.js';
import { TAB_HEIGHT_UNSCALED } from './stack.js';

export enum NodeKind {
    FORK = 1,
    LEAF = 3,
}

export interface NodeFork {
    kind: NodeKind.FORK;
    fork: Fork;
    parent: Fork | null;
}

export interface NodeLeaf {
    kind: NodeKind.LEAF;
    tabbed: boolean;
    idx: number | null;
    windows: Array<MutterWindowHandle>;
    active: MutterWindowHandle;
    prev_active: MutterWindowHandle | null;
    rect: Mtk.Rectangle | null;
    parent: Fork | null;
}

/*
 * A stack's windows, their order, and which of them is active only change through the functions
 * below, which draw the stack again before they return.
 */

export interface TabBars {
    update_stack(stack: NodeLeaf): void;
}

function sync_tabs(tabs: TabBars | null, node: NodeLeaf) {
    tabs?.update_stack(node);
}

export function stack_find(node: NodeLeaf, entity: Entity) {
    const idx = node.windows.findIndex(other => Ecs.entity_eq(entity, other.entity));
    return idx === -1 ? null : idx;
}

export function stack_activate(tabs: TabBars | null, node: NodeLeaf, entity: Entity) {
    const idx = stack_find(node, entity);
    const window = idx === null ? undefined : node.windows[idx];
    if (!window) return;

    if (node.active !== window) {
        node.prev_active = node.active;
        node.active = window;
    }

    sync_tabs(tabs, node);
}

export function stack_insert(tabs: TabBars | null, node: NodeLeaf, window: MutterWindowHandle, at_end: boolean) {
    if (at_end) {
        node.windows.push(window);
    } else {
        node.windows.unshift(window);
    }
    node.parent?.hold_window(node, window);

    sync_tabs(tabs, node);
}

/** Removes a window from a stack */
export function stack_remove(tabs: TabBars | null, node: NodeLeaf, entity: Entity): number | null {
    const idx = stack_find(node, entity);
    if (idx === null) return null;

    const [window] = node.windows.splice(idx, 1);
    if (!window) return null;
    node.parent?.let_go_window(node, window);

    if (node.prev_active === window) node.prev_active = null;

    if (node.active === window) {
        const next = node.prev_active ?? node.windows[Math.min(idx, node.windows.length - 1)];
        if (next) node.active = next;
        node.prev_active = null;
    }

    sync_tabs(tabs, node);
    return idx;
}

export function stack_replace(tabs: TabBars | null, node: NodeLeaf, old: Entity, window: MutterWindowHandle) {
    const idx = stack_find(node, old);
    const previous = idx === null ? undefined : node.windows[idx];
    if (idx === null || !previous) return;

    node.windows[idx] = window;
    node.parent?.hold_window(node, window);
    // A window that replaced itself stays linked
    if (stack_find(node, old) === null) node.parent?.let_go_window(node, previous);
    if (node.active === previous) node.active = window;
    if (node.prev_active === previous) node.prev_active = window;

    sync_tabs(tabs, node);
}

function stack_swap(tabs: TabBars | null, node: NodeLeaf, from: number, to: number) {
    const a = node.windows[from];
    const b = node.windows[to];
    if (a === undefined || b === undefined) return;

    node.windows[from] = b;
    node.windows[to] = a;
    sync_tabs(tabs, node);
}

/** Move the window in a stack to the left, and detach if it it as the end. */
export function stack_move_left(tabs: TabBars | null, node: NodeLeaf, entity: Entity): boolean {
    const idx = stack_find(node, entity);
    if (idx === null) return false;

    if (idx === 0) {
        stack_remove(tabs, node, entity);
        return false;
    }

    stack_swap(tabs, node, idx - 1, idx);
    return true;
}

/** Move the window in a stack to the right, and detach if it is at the end. */
export function stack_move_right(tabs: TabBars | null, node: NodeLeaf, entity: Entity): boolean {
    const idx = stack_find(node, entity);
    if (idx === null) return false;

    if (idx === node.windows.length - 1) {
        stack_remove(tabs, node, entity);
        return false;
    }

    stack_swap(tabs, node, idx + 1, idx);
    return true;
}

export type NodeADT = NodeFork | NodeLeaf;

/** A tiling node may either refer to a window entity, or another fork entity */
export class Node<T extends NodeADT = NodeADT> {
    /** The actual data for this node */
    inner: T;

    constructor(inner: T) {
        this.inner = inner;
    }

    /** Create a fork variant of a `Node` */
    static fork(fork: Fork): Node<NodeFork> {
        return new Node({ kind: NodeKind.FORK, fork, parent: null });
    }

    static window(window: MutterWindowHandle): Node<NodeLeaf> {
        return new Node({
            kind: NodeKind.LEAF,
            tabbed: false,
            idx: null,
            windows: [window],
            active: window,
            prev_active: null,
            rect: null,
            parent: null,
        });
    }

    is_leaf(): this is Node<NodeLeaf> {
        return this.inner.kind === NodeKind.LEAF;
    }

    has(entity: Entity): this is Node<NodeLeaf> {
        return this.is_leaf() && this.inner.windows.some(other => Ecs.entity_eq(entity, other.entity));
    }

    is_in_stack(entity: Entity): this is Node<NodeLeaf> {
        return this.has(entity) && this.inner.tabbed;
    }

    /** Asks if this fork is the fork we are looking for */
    is_fork(entity: Entity): boolean {
        return this.inner.kind === NodeKind.FORK && Ecs.entity_eq(this.inner.fork.entity, entity);
    }

    is_window(entity: Entity): this is Node<NodeLeaf> {
        return this.has(entity) && !this.inner.tabbed;
    }

    lone_window(): MutterWindowHandle | null {
        return this.is_leaf() && !this.inner.tabbed ? (this.inner.windows[0] ?? null) : null;
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
                const fork = this.inner.fork;
                if (!fork.detached) {
                    fork.measure(tiler, ext, area, record);
                }

                break;
            case NodeKind.LEAF:
                this.inner.rect = area.copy();
                if (this.inner.tabbed) {
                    const tab_height = ext.sizes.scale * TAB_HEIGHT_UNSCALED;
                    this.inner.rect.y += tab_height;
                    this.inner.rect.height -= tab_height;
                }

                for (const window of this.inner.windows) {
                    record(window.entity, parent, this.inner.tabbed ? this.inner.rect : this.inner.rect.copy());
                }

                if (this.inner.tabbed && ext.gnome_forest) {
                    ext.gnome_forest.forest.stack_updates.push([this.inner, parent]);
                }
        }
    }
}
