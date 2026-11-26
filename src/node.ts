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

export interface NodeFork {
    kind: NodeKind.FORK;
    fork: Fork;
    parent: Fork | null;
}

/** Identifies this node as a window */
export interface NodeWindow {
    kind: NodeKind.WINDOW;
    window: MutterWindowHandle;
    parent: Fork | null;
}

export interface NodeStack {
    kind: NodeKind.STACK;
    idx: number;
    windows: Array<MutterWindowHandle>;
    rect: Mtk.Rectangle | null;
    parent: Fork | null;
}

export function stack_add(node: NodeStack, window: MutterWindowHandle, front = false) {
    if (front) {
        node.windows.unshift(window);
    } else {
        node.windows.push(window);
    }
    node.parent?.hold_window(node, window);
}

export function stack_set(node: NodeStack, idx: number, window: MutterWindowHandle) {
    const previous = node.windows[idx];
    node.windows[idx] = window;
    node.parent?.hold_window(node, window);
    if (previous) node.parent?.let_go_window(node, previous);
}

function stack_take(node: NodeStack, idx: number) {
    const [window] = node.windows.splice(idx, 1);
    if (window) node.parent?.let_go_window(node, window);
}

export function window_set(node: NodeWindow, window: MutterWindowHandle) {
    const previous = node.window;
    node.window = window;
    node.parent?.hold_window(node, window);
    node.parent?.let_go_window(node, previous);
}

function stack_detach(node: NodeStack, stack: Stack, idx: number) {
    stack_take(node, idx);
    stack.remove_by_pos(idx);
}

export function stack_find(node: NodeStack, entity: Entity) {
    let idx = 0;
    while (idx < node.windows.length) {
        if (Ecs.entity_eq(entity, node.windows[idx]!.entity)) {
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
    for (const cmp of node.windows) {
        if (Ecs.entity_eq(cmp.entity, entity)) {
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
    const max = node.windows.length - 1;
    for (const cmp of node.windows) {
        if (Ecs.entity_eq(cmp.entity, entity)) {
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
    const tmp = node.windows[from];
    node.windows[from] = node.windows[to]!;
    node.windows[to] = tmp!;
}

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
    static fork(fork: Fork): Node<NodeFork> {
        return new Node({ kind: NodeKind.FORK, fork, parent: null });
    }

    /** Create the window variant of a `Node` */
    static window(window: MutterWindowHandle): Node<NodeWindow> {
        return new Node({ kind: NodeKind.WINDOW, window, parent: null });
    }

    static stacked(window: MutterWindowHandle, idx: number): Node<NodeStack> {
        return new Node({
            kind: NodeKind.STACK,
            windows: [window],
            idx,
            rect: null,
            parent: null,
        });
    }

    has(entity: Entity): boolean {
        return this.is_window(entity) || this.is_in_stack(entity);
    }

    /** Check if the entity exists as a child of this stack */
    is_in_stack(entity: Entity): this is Node<T> & { inner: NodeStack } {
        if (this.inner.kind === NodeKind.STACK) {
            for (const compare of this.inner.windows) {
                if (Ecs.entity_eq(entity, compare.entity)) return true;
            }
        }

        return false;
    }

    /** Asks if this fork is the fork we are looking for */
    is_fork(entity: Entity): boolean {
        return this.inner.kind === NodeKind.FORK && Ecs.entity_eq(this.inner.fork.entity, entity);
    }

    /** Asks if this window is the window we are looking for */
    is_window(entity: Entity): boolean {
        return this.inner.kind === NodeKind.WINDOW && Ecs.entity_eq(this.inner.window.entity, entity);
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
            case NodeKind.WINDOW:
                record(this.inner.window.entity, parent, area.copy());
                break;
            case NodeKind.STACK:
                const tab_height = ext.sizes.scale * TAB_HEIGHT_UNSCALED;

                this.inner.rect = area.copy();
                this.inner.rect.y += tab_height;
                this.inner.rect.height -= tab_height;

                for (const window of this.inner.windows) {
                    record(window.entity, parent, this.inner.rect);
                }

                if (ext.gnome_forest) {
                    ext.gnome_forest.forest.stack_updates.push([this.inner, parent]);
                }
        }
    }
}
