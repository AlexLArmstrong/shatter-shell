import type { Fork } from './fork.js';

import { copy_rect, type Rect } from './core/geom.js';

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

export interface NodeFork {
    kind: NodeKind.FORK;
    fork: Fork;
    /** The fork whose branch this is, kept by {@link Fork} */
    parent: Fork | null;
}

/**
 * A leaf of the tree, which holds windows and shows one of them at a time. A tabbed leaf is drawn
 * by a Stack in Forest.stacks, and a leaf without tabs holds exactly one window.
 */
export interface NodeStack {
    kind: NodeKind.STACK;
    /** Whether the leaf has a tab bar, and so can hold more than one window */
    tabbed: boolean;
    /** The index of the Stack in Forest.stacks that draws this leaf, which only a tabbed one has */
    idx: number | null;
    /** The windows, in the order of their tabs */
    windows: Array<WindowId>;
    /** The window that is shown. It's always one of the windows while there are any. */
    active: WindowId;
    /** The window that was shown before, which is shown again when the active one leaves */
    prev_active: WindowId | null;
    rect: Rect | null;
    /** The fork whose branch this is, kept by {@link Fork} */
    parent: Fork | null;
}

export type NodeLeaf = NodeStack;

/*
 * A stack's windows, their order, and which of them is active only change through the functions
 * below, which draw the stack again before they return.
 */

/** Draws the tab bars of leaves again from the tree */
export interface TabBars {
    update(leaf: NodeStack): void;
}

/** What laying out a tree needs from outside of it, and where its results go */
export interface Layout {
    /** The gap between windows, in pixels */
    readonly gap_inner: number;

    /** Half of the gap between windows, in pixels */
    readonly gap_inner_half: number;

    /** The height that a tabbed leaf keeps for its tab bar, in pixels */
    tab_height(): number;

    /** Whether the user is moving or resizing a window right now, which keeps the forks' ratios */
    manually_moved(): boolean;

    /** The smallest width and height that a window can have */
    minimum_size(window: WindowId): [number, number];

    /** Says where a window of the fork `parent` goes */
    place(window: WindowId, parent: Fork, rect: Rect): void;

    /** Says that the tab bar of a tabbed leaf of `parent` needs placing again */
    restack(leaf: NodeStack, parent: Fork): void;
}

/** Draws the stack again from the tree */
function sync_tabs(tabs: TabBars, node: NodeStack) {
    tabs.update(node);
}

export function stack_find(node: NodeStack, window_id: WindowId) {
    const idx = node.windows.findIndex(other => window_id === other);
    return idx === -1 ? null : idx;
}

/** Shows this window of the stack, and remembers the one that was shown before */
export function stack_activate(tabs: TabBars, node: NodeStack, window_id: WindowId) {
    if (stack_find(node, window_id) === null) return;

    if (node.active !== window_id) {
        node.prev_active = node.active;
        node.active = window_id;
    }

    sync_tabs(tabs, node);
}

/** Adds a window at either end of a stack, behind its active window */
export function stack_insert(tabs: TabBars, node: NodeStack, window_id: WindowId, at_end: boolean) {
    if (at_end) {
        node.windows.push(window_id);
    } else {
        node.windows.unshift(window_id);
    }
    node.parent?.hold_window(node, window_id);

    sync_tabs(tabs, node);
}

/**
 * Removes a window from a stack, returning where it was. If it was the active one, the previously
 * active window takes over if it's still there, and otherwise the one that is now in its place.
 */
export function stack_remove(tabs: TabBars, node: NodeStack, window_id: WindowId): number | null {
    const idx = stack_find(node, window_id);
    if (idx === null) return null;

    node.windows.splice(idx, 1);
    node.parent?.let_go_window(node, window_id);

    if (node.prev_active === window_id) node.prev_active = null;

    if (node.active === window_id) {
        const next = node.prev_active ?? node.windows[Math.min(idx, node.windows.length - 1)];
        if (next !== undefined) node.active = next;
        node.prev_active = null;
    }

    sync_tabs(tabs, node);
    return idx;
}

/**
 * Puts another window in the place of one in a stack, such as when swapping windows, and makes it
 * active if that one was
 */
export function stack_replace(tabs: TabBars, node: NodeStack, old: WindowId, window_id: WindowId) {
    const idx = stack_find(node, old);
    if (idx === null) return;

    node.windows[idx] = window_id;
    node.parent?.hold_window(node, window_id);
    // A window that is still in the stack, such as when it replaces itself, stays linked to it
    if (stack_find(node, old) === null) node.parent?.let_go_window(node, old);
    if (node.active === old) node.active = window_id;
    if (node.prev_active === old) node.prev_active = window_id;

    sync_tabs(tabs, node);
}

function stack_swap(tabs: TabBars, node: NodeStack, from: number, to: number) {
    const a = node.windows[from];
    const b = node.windows[to];
    if (a === undefined || b === undefined) return;

    node.windows[from] = b;
    node.windows[to] = a;
    sync_tabs(tabs, node);
}

/** Move the window in a stack to the left, and detach if it it as the end. */
export function stack_move_left(tabs: TabBars, node: NodeStack, window_id: WindowId): boolean {
    const idx = stack_find(node, window_id);
    if (idx === null) return false;

    if (idx === 0) {
        stack_remove(tabs, node, window_id);
        return false;
    }

    stack_swap(tabs, node, idx - 1, idx);
    return true;
}

/** Move the window in a stack to the right, and detach if it is at the end. */
export function stack_move_right(tabs: TabBars, node: NodeStack, window_id: WindowId): boolean {
    const idx = stack_find(node, window_id);
    if (idx === null) return false;

    if (idx === node.windows.length - 1) {
        stack_remove(tabs, node, window_id);
        return false;
    }

    stack_swap(tabs, node, idx + 1, idx);
    return true;
}

export type NodeADT = NodeFork | NodeStack;

/** A node of the tree: a leaf of windows, or a fork */
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

    /** Creates a leaf of one window, without tabs */
    static window(window_id: WindowId): Node<NodeStack> {
        return new Node({
            kind: NodeKind.STACK,
            tabbed: false,
            idx: null,
            windows: [window_id],
            active: window_id,
            prev_active: null,
            rect: null,
            parent: null,
        });
    }

    /** Generates a string representation of the this value. */
    display(): string {
        let fmt = `Node{\n    kind: ${node_kind_as_string(this.inner.kind)},\n`;
        switch (this.inner.kind) {
            case NodeKind.FORK:
                fmt += `    fork: (${this.inner.fork.id})\n  }`;
                break;
            case NodeKind.STACK:
                fmt += `    tabbed: ${this.inner.tabbed}, windows: ${this.inner.windows}\n  }`;
                break;
        }
        return fmt;
    }

    /** Whether this is a leaf, which every node but a fork is */
    is_leaf(): this is Node<NodeStack> {
        return this.inner.kind === NodeKind.STACK;
    }

    /** Whether this is a leaf that holds the window, with tabs or without */
    has(window_id: WindowId): this is Node<NodeStack> {
        return this.is_leaf() && this.inner.windows.some(other => window_id === other);
    }

    /** Whether this is a leaf with tabs that holds the window */
    is_in_stack(window_id: WindowId): this is Node<NodeStack> {
        return this.has(window_id) && this.inner.tabbed;
    }

    /** Asks if this fork is the fork we are looking for */
    is_fork(fork: Fork): boolean {
        return this.inner.kind === NodeKind.FORK && this.inner.fork === fork;
    }

    /** Whether this is a leaf without tabs, which holds only this window */
    is_window(window_id: WindowId): this is Node<NodeStack> {
        return this.has(window_id) && !this.inner.tabbed;
    }

    /** The window of a leaf without tabs, or null for any other node */
    lone_window(): WindowId | null {
        return this.is_leaf() && !this.inner.tabbed ? (this.inner.windows[0] ?? null) : null;
    }

    /** Calculates the future arrangement of windows in this node */
    measure(layout: Layout, parent: Fork, area: Rect) {
        switch (this.inner.kind) {
            case NodeKind.FORK:
                const fork = this.inner.fork;
                if (!fork.detached) {
                    fork.measure(layout, area);
                }

                break;
            case NodeKind.STACK:
                // Only a tabbed leaf leaves room for its tab bar
                this.inner.rect = copy_rect(area);
                if (this.inner.tabbed) {
                    const tab_height = layout.tab_height();
                    this.inner.rect.y = Math.trunc(this.inner.rect.y + tab_height);
                    this.inner.rect.height = Math.trunc(this.inner.rect.height - tab_height);
                }

                for (const window_id of this.inner.windows) {
                    layout.place(window_id, parent, this.inner.tabbed ? this.inner.rect : copy_rect(this.inner.rect));
                }

                if (this.inner.tabbed) layout.restack(this.inner, parent);
        }
    }
}
