import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Fork } from '../src/core/fork.js';
import type { Rect } from '../src/core/geom.js';
import type { NodeStack } from '../src/core/node.js';

import { Forest, type LayoutSource, type TabBar } from '../src/core/forest.js';
import { monitorID, workspaceID } from '../src/core/ids.js';
import { LayoutSizes } from '../src/core/layout_sizes.js';
import { Movement } from '../src/core/movement.js';
import { NodeKind, stack_remove } from '../src/core/node.js';
import { Orientation } from '../src/core/orientation.js';

/** A tab bar that remembers what it was asked */
class FakeTabBar implements TabBar {
    activated: Array<number> = [];
    destroyed = false;
    activate(window: number) {
        this.activated.push(window);
    }
    destroy() {
        this.destroyed = true;
    }
}

/** A forest over workspaces A and B, of which A is active, and what it drew and warned about */
function forest_of(windows: Array<number>, focused: number | null = null) {
    const workspaces: Array<object> = [{ name: 'A' }, { name: 'B' }];
    const updated: Array<NodeStack> = [];
    const warnings: Array<string> = [];
    const forest = new Forest<FakeTabBar>(
        { index_of: w => workspaces.indexOf(w), at: i => workspaces[i] ?? null, active: () => workspaces[0]! },
        { update: leaf => updated.push(leaf) },
        new LayoutSizes(1),
        { has: window => windows.includes(window), has_focus: window => window === focused },
        message => warnings.push(message),
    );
    return { forest, updated, warnings };
}

/** Lays out with no gaps and no minimum sizes */
const source = (tab_height = 0): LayoutSource => ({
    gap_inner: 0,
    gap_inner_half: 0,
    tab_height: () => tab_height,
    manually_moved: () => false,
    minimum_size: () => [0, 0],
});

const at = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const AUTO = { auto: 0 } as const;

/** A forest with one tree of window 1, on monitor 0 and workspace 0, and what it attached and detached */
function forest_with_one(windows: Array<number> = [1, 2, 3, 4], focused: number | null = null) {
    const { forest, updated, warnings } = forest_of(windows, focused);
    const attached: Array<number> = [];
    const detached: Array<number> = [];
    forest.connect_on_attach(w => attached.push(w)).connect_on_detach(w => detached.push(w));
    const top = forest.add_tree(1, at(0, 0, 1000, 500), [monitorID(0), workspaceID(0)], true).root;
    return { forest, top, attached, detached, updated, warnings };
}

describe('Forest', () => {
    test('a new tree has one window, on its monitor and workspace', () => {
        const { forest, top } = forest_with_one();
        assert.equal(top.is_root, true);
        assert.equal(top.left.lone_window(), 1);
        assert.equal(top.right, null);
        assert.equal(top.workspace, 0);
        assert.equal(top.on_primary_display, true);
        assert.equal(forest.find_tree([monitorID(0), workspaceID(0)])?.root, top);
        assert.equal(forest.find_tree([monitorID(0), workspaceID(1)]), null);
        assert.deepEqual(
            [...forest.trees()].map(tree => tree.root),
            [top],
        );
    });

    test('a window attached to a lone window takes the other branch of its fork', () => {
        const { forest, top, attached } = forest_with_one();
        assert.equal(forest.attach_window(1, 2, AUTO, false), top);
        assert.equal(top.right?.lone_window(), 2);
        assert.equal(forest.fork_of(2), top);
        assert.deepEqual(attached, [2]);
        assert.deepEqual(
            [...forest.tiled()].map(([w]) => w),
            [1, 2],
        );
    });

    test('a window attached to one of two windows gets a new fork with it', () => {
        const { forest, top } = forest_with_one();
        forest.attach_window(1, 2, AUTO, false);
        const fork = forest.attach_window(1, 3, AUTO, false);

        assert.equal(fork, top);
        assert.equal(top.left.inner.kind, NodeKind.FORK);
        const inner = top.left.inner.kind === NodeKind.FORK ? top.left.inner.fork : null;
        assert.equal(inner?.left.lone_window(), 1);
        assert.equal(inner?.right?.lone_window(), 3);
        assert.ok(inner);
        assert.equal(forest.parent_of(inner), top);
        assert.equal(forest.fork_of(3), inner);
    });

    test('a window dropped at the left side of another goes left of it, side by side', () => {
        const { forest, top } = forest_with_one();
        forest.attach_window(1, 2, AUTO, false);
        forest.attach_window(2, 3, { orientation: Orientation.VERTICAL, swap: true }, false);

        const inner = top.right?.inner.kind === NodeKind.FORK ? top.right.inner.fork : null;
        assert.equal(inner?.orientation, Orientation.VERTICAL);
        assert.equal(inner?.left.lone_window(), 3);
        assert.equal(inner?.right?.lone_window(), 2);
    });

    test('nothing is attached to a window that is not in a tree', () => {
        const { forest } = forest_with_one();
        assert.equal(forest.attach_window(9, 2, AUTO, false), null);
    });

    test('detaching a window of two leaves the other, and says so', () => {
        const { forest, top, detached } = forest_with_one();
        forest.attach_window(1, 2, AUTO, false);

        assert.equal(forest.detach(top, 2), top);
        assert.equal(top.right, null);
        assert.equal(forest.fork_of(2), null);
        assert.deepEqual(detached, [2]);
    });

    test('detaching from a nested fork puts the other window in its place, and removes the fork', () => {
        const { forest, top } = forest_with_one();
        forest.attach_window(1, 2, AUTO, false);
        forest.attach_window(1, 3, AUTO, false);
        const inner = forest.fork_of(3)!;

        assert.equal(forest.detach(inner, 3), top);
        assert.equal(top.left.lone_window(), 1);
        assert.equal(inner.detached, true);
        assert.equal(forest.forks.has(inner), false);
    });

    test('the last window leaving a tree removes it', () => {
        const { forest, top } = forest_with_one();
        assert.equal(forest.detach(top, 1), null);
        assert.equal(top.detached, true);
        assert.deepEqual([...forest.trees()], []);
    });

    describe('stacks', () => {
        /** A tree whose left leaf is a tabbed stack of window 1, drawn by a fake tab bar */
        function stacked(focused: number | null = null) {
            const made = forest_with_one([1, 2, 3, 4], focused);
            const leaf = made.top.left.inner;
            assert.ok(leaf.kind === NodeKind.STACK);
            const bar = new FakeTabBar();
            leaf.tabbed = true;
            leaf.idx = made.forest.stacks.insert(bar);
            return { ...made, leaf, bar };
        }

        test('a window attached to a window in a stack joins the stack', () => {
            const { forest, top, leaf, updated } = stacked();
            assert.equal(forest.attach_window(1, 2, AUTO, true), top);
            assert.deepEqual(leaf.windows, [1, 2]);
            assert.equal(updated.length, 1);
        });

        test('its tab is shown if it has the focus', () => {
            const { forest, bar } = stacked(2);
            forest.attach_window(1, 2, AUTO, true);
            assert.deepEqual(bar.activated, [2]);
        });

        test('a window that is not managed does not join it', () => {
            const { forest, leaf, warnings } = stacked();
            assert.equal(forest.attach_window(1, 9, AUTO, true), null);
            assert.deepEqual(leaf.windows, [1]);
            assert.equal(warnings.length, 1);
        });

        test('a window leaves a stack of several, which keeps its place', () => {
            const { forest, top, leaf } = stacked();
            forest.attach_window(1, 2, AUTO, true);
            assert.equal(forest.detach(top, 2), top);
            assert.deepEqual(leaf.windows, [1]);
            assert.equal(top.left.inner, leaf);
        });

        test('the last window leaving a stack takes its tab bar with it', () => {
            const { forest, top, bar } = stacked();
            forest.attach_fork(top, 2, false);
            forest.detach(top, 1);
            assert.equal(top.left.lone_window(), 2);
            assert.equal(bar.destroyed, true);
        });
    });

    test('iter walks every branch of the tree below a fork', () => {
        const { forest, top } = forest_with_one();
        forest.attach_window(1, 2, AUTO, false);
        forest.attach_window(1, 3, AUTO, false);
        const windows = [...forest.iter(top)].filter(n => n.is_leaf()).map(n => n.inner.windows[0]);
        assert.deepEqual(
            windows.sort((a, b) => (a ?? 0) - (b ?? 0)),
            [1, 2, 3],
        );
    });

    test('its layout keeps where windows go, and which tab bars need placing', () => {
        const { forest, top } = forest_with_one();
        forest.attach_window(1, 2, AUTO, false);
        const layout = forest.layout(source());

        top.measure(layout, top.area);

        assert.deepEqual(forest.requested.get(1)?.rect, at(0, 0, 500, 500));
        assert.equal(forest.requested.get(2)?.parent, top);
        assert.deepEqual(forest.stack_updates, []);
    });

    test('resizing a window grows its side of the fork', () => {
        const { forest, top } = forest_with_one();
        forest.attach_window(1, 2, AUTO, false);
        const layout = forest.layout(source());

        forest.resize(layout, top, 1, Movement.GROW | Movement.RIGHT, at(0, 0, 600, 500));

        assert.equal(top.length_left, 600);
        assert.equal(forest.requested.get(1)?.rect.width, 608);
    });

    describe('tabs', () => {
        const layout = (forest: Forest<FakeTabBar>) => forest.layout(source(20));

        test('toggling a lone window gives its leaf tabs and a tab bar', () => {
            const { forest, top } = forest_with_one();
            forest.attach_window(1, 2, AUTO, false);
            const bars: Array<FakeTabBar> = [];

            forest.unstack(layout(forest), top, 1, true, () => {
                const bar = new FakeTabBar();
                bars.push(bar);
                return bar;
            });

            const leaf = top.left.inner;
            assert.ok(leaf.kind === NodeKind.STACK);
            assert.equal(leaf.tabbed, true);
            assert.equal(forest.view_of(leaf), bars[0]);
            assert.equal(forest.requested.get(1)?.rect.y, 20);
        });

        test('toggling a stack of only that window takes its tabs and tab bar', () => {
            const { forest, top } = forest_with_one();
            forest.attach_window(1, 2, AUTO, false);
            const bar = new FakeTabBar();
            forest.unstack(layout(forest), top, 1, true, () => bar);

            forest.unstack(layout(forest), top, 1, true, () => new FakeTabBar());

            const leaf = top.left.inner;
            assert.ok(leaf.kind === NodeKind.STACK);
            assert.equal(leaf.tabbed, false);
            assert.equal(bar.destroyed, true);
        });

        test('a stack of several windows keeps its tabs', () => {
            const { forest, top } = forest_with_one();
            forest.attach_window(1, 2, AUTO, false);
            forest.create_stack(layout(forest), 1, () => new FakeTabBar());
            forest.attach_window(1, 3, AUTO, true);

            forest.unstack(layout(forest), top, 1, true, () => new FakeTabBar());

            const leaf = top.left.inner;
            assert.ok(leaf.kind === NodeKind.STACK);
            assert.equal(leaf.tabbed, true);
            assert.deepEqual(leaf.windows, [1, 3]);
        });

        test('create_stack gives a window that is not stacked tabs, and leaves others alone', () => {
            const { forest, top } = forest_with_one();
            forest.attach_window(1, 2, AUTO, false);
            let made = 0;
            const make = () => {
                made += 1;
                return new FakeTabBar();
            };

            forest.create_stack(layout(forest), 2, make);
            forest.create_stack(layout(forest), 2, make);
            forest.create_stack(layout(forest), 9, make);

            assert.equal(made, 1);
            assert.equal(top.right?.inner.kind === NodeKind.STACK && top.right.inner.tabbed, true);
        });
    });

    describe('the links back up the trees', () => {
        /** Finds the fork that holds a window's leaf by walking every fork */
        const scan_fork_of = (forest: Forest, window: number) =>
            [...forest.forks].find(f => f.left.has(window) || f.right?.has(window)) ?? null;

        /** Finds the fork that holds a fork by walking every fork */
        const scan_parent_of = (forest: Forest, child: Fork) =>
            [...forest.forks].find(f => f.left.is_fork(child) || f.right?.is_fork(child)) ?? null;

        /** A generator of numbers in [0, 1) that gives the same ones for the same seed */
        function random(seed: number) {
            return () => {
                seed = (seed + 0x6d2b79f5) | 0;
                let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }

        const all = Array.from({ length: 24 }, (_, i) => i + 1);

        test('agree with walking the trees, through random attaches, detaches, tabs and swaps', () => {
            for (let seed = 1; seed <= 40; seed++) {
                const next = random(seed);
                const pick = <T>(items: Array<T>): T | undefined => items[Math.floor(next() * items.length)];
                const { forest } = forest_of(all);
                const layout = forest.layout(source(20));
                const tabs = { update: () => {} };

                for (let step = 0; step < 300; step++) {
                    const tiled = all.filter(w => scan_fork_of(forest, w) !== null);
                    const untiled = all.filter(w => !tiled.includes(w));
                    const w = pick(tiled);
                    const fork = w === undefined ? null : scan_fork_of(forest, w);

                    switch (Math.floor(next() * 9)) {
                        case 0:
                        case 1: {
                            const add = pick(untiled);
                            if (add === undefined) break;
                            if (w === undefined || next() < 0.1) {
                                const id: MonitorWorkspaceID = [monitorID(0), workspaceID(Math.floor(next() * 2))];
                                if (!forest.find_tree(id)) forest.add_tree(add, at(0, 0, 1000, 500), id, true);
                            } else {
                                const place = pick([AUTO, { orientation: Orientation.VERTICAL, swap: next() < 0.5 }])!;
                                forest.attach_window(w, add, place, next() < 0.5);
                            }
                            break;
                        }
                        case 2:
                            if (fork && w !== undefined) forest.detach(fork, w);
                            break;
                        case 3:
                            // Gives a leaf tabs or takes them away, as toggling stacking does
                            if (fork && w !== undefined) forest.unstack(layout, fork, w, true, () => new FakeTabBar());
                            break;
                        case 4: {
                            // Takes a window out of its stack before detaching it, as the keyboard does
                            const side = fork && w !== undefined ? fork.find_branch(w) : null;
                            if (!side?.is_leaf() || !side.inner.tabbed || w === undefined) break;
                            stack_remove(tabs, side.inner, w);
                            forest.detach(fork!, w);
                            break;
                        }
                        case 5:
                            if (fork && next() < 0.5) {
                                fork.swap_branches();
                            } else if (fork) {
                                fork.toggle_orientation();
                            }
                            break;
                        case 6: {
                            // Swaps two windows, as dragging one onto another does
                            const other = pick(tiled);
                            const other_fork = other === undefined ? null : scan_fork_of(forest, other);
                            if (!fork || !other_fork || w === undefined || other === undefined || w === other) break;
                            const a = fork.replace_window(tabs, w, other);
                            const b = other_fork.replace_window(tabs, other, w);
                            if (a && b) {
                                a();
                                b();
                            }
                            break;
                        }
                        case 7: {
                            // Puts a window back into the fork it was in, as unminimizing does
                            const add = pick(untiled);
                            if (fork && add !== undefined) forest.attach_fork(fork, add, next() < 0.5);
                            break;
                        }
                        case 8:
                            if (fork) fork.measure(layout, fork.area);
                            break;
                    }

                    for (const window of all) {
                        assert.equal(
                            forest.fork_of(window),
                            scan_fork_of(forest, window),
                            `seed ${seed}, step ${step}`,
                        );
                    }
                    for (const each of forest.forks) {
                        assert.equal(
                            forest.parent_of(each),
                            scan_parent_of(forest, each),
                            `seed ${seed}, step ${step}`,
                        );
                        assert.equal(
                            each.is_root,
                            [...forest.trees()].some(tree => tree.root === each),
                        );
                    }
                }
            }
        });
    });
});
