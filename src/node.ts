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

export interface TabBars {
    update_stack(stack: NodeLeaf): void;
}

export class NodeLeaf {
    readonly kind: NodeKind.LEAF = NodeKind.LEAF;
    tabbed = false;
    idx: number | null = null;
    rect: Mtk.Rectangle | null = null;
    parent: Fork | null = null;

    private readonly _windows: Array<MutterWindowHandle>;
    private _active: MutterWindowHandle;
    private _prev_active: MutterWindowHandle | null = null;

    constructor(window: MutterWindowHandle) {
        this._windows = [window];
        this._active = window;
    }

    get windows(): ReadonlyArray<MutterWindowHandle> {
        return this._windows;
    }

    get active(): MutterWindowHandle {
        return this._active;
    }

    get prev_active(): MutterWindowHandle | null {
        return this._prev_active;
    }

    find(entity: Entity): number | null {
        const idx = this._windows.findIndex(other => Ecs.entity_eq(entity, other.entity));
        return idx === -1 ? null : idx;
    }

    activate(tabs: TabBars | null, entity: Entity) {
        const idx = this.find(entity);
        const window = idx === null ? undefined : this._windows[idx];
        if (!window) return;

        if (this._active !== window) {
            this._prev_active = this._active;
            this._active = window;
        }

        tabs?.update_stack(this);
    }

    insert(tabs: TabBars | null, window: MutterWindowHandle, at_end: boolean) {
        if (at_end) {
            this._windows.push(window);
        } else {
            this._windows.unshift(window);
        }
        this.parent?.hold_window(this, window);

        tabs?.update_stack(this);
    }

    remove(tabs: TabBars | null, entity: Entity): number | null {
        const idx = this.find(entity);
        if (idx === null) return null;

        const [window] = this._windows.splice(idx, 1);
        if (!window) return null;
        this.parent?.let_go_window(this, window);

        if (this._prev_active === window) this._prev_active = null;

        if (this._active === window) {
            const next = this._prev_active ?? this._windows[Math.min(idx, this._windows.length - 1)];
            if (next) this._active = next;
            this._prev_active = null;
        }

        tabs?.update_stack(this);
        return idx;
    }

    replace(tabs: TabBars | null, old: Entity, window: MutterWindowHandle) {
        const idx = this.find(old);
        const previous = idx === null ? undefined : this._windows[idx];
        if (idx === null || !previous) return;

        this._windows[idx] = window;
        this.parent?.hold_window(this, window);
        // A window that replaced itself stays linked
        if (this.find(old) === null) this.parent?.let_go_window(this, previous);
        if (this._active === previous) this._active = window;
        if (this._prev_active === previous) this._prev_active = window;

        tabs?.update_stack(this);
    }

    move_left(tabs: TabBars | null, entity: Entity): boolean {
        const idx = this.find(entity);
        if (idx === null) return false;

        if (idx === 0) {
            this.remove(tabs, entity);
            return false;
        }

        this.swap(tabs, idx - 1, idx);
        return true;
    }

    move_right(tabs: TabBars | null, entity: Entity): boolean {
        const idx = this.find(entity);
        if (idx === null) return false;

        if (idx === this._windows.length - 1) {
            this.remove(tabs, entity);
            return false;
        }

        this.swap(tabs, idx + 1, idx);
        return true;
    }

    private swap(tabs: TabBars | null, from: number, to: number) {
        const a = this._windows[from];
        const b = this._windows[to];
        if (a === undefined || b === undefined) return;

        this._windows[from] = b;
        this._windows[to] = a;
        tabs?.update_stack(this);
    }
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
        return new Node(new NodeLeaf(window));
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
