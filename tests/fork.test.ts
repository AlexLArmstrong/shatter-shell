import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Rect } from '../src/core/geom.js';
import type { Layout, NodeStack, TabBars } from '../src/core/node.js';

import { Fork, Tree, type TreeLinks, type WorkspaceList } from '../src/core/fork.js';
import { monitorID, workspaceID } from '../src/core/ids.js';
import { LayoutSizes } from '../src/core/layout_sizes.js';
import { Node } from '../src/core/node.js';
import { Orientation } from '../src/core/orientation.js';

/** Workspaces A and B, at indices 0 and 1, of which a test can remove one */
class FakeWorkspaces implements WorkspaceList {
    all: Array<object> = [{ name: 'A' }, { name: 'B' }];
    index_of(workspace: object) {
        return this.all.indexOf(workspace);
    }
    at(index: number) {
        return this.all[index] ?? null;
    }
}

/** The links back up a tree, which only the forks keep */
const links = (): TreeLinks => ({ leaves: new Map() });

/** A layout with a gap of 8, tabs 20 high and the minimum sizes it's given, which keeps what it's told */
class FakeLayout implements Layout {
    readonly gap_inner = 8;
    readonly gap_inner_half = 4;
    moving = false;
    minimums = new Map<number, [number, number]>();
    placed = new Map<number, Rect>();
    parents = new Map<number, Fork>();
    restacked: Array<NodeStack> = [];
    tab_height() {
        return 20;
    }
    manually_moved() {
        return this.moving;
    }
    minimum_size(window: number): [number, number] {
        return this.minimums.get(window) ?? [0, 0];
    }
    place(window: number, parent: Fork, rect: Rect) {
        this.placed.set(window, { ...rect });
        this.parents.set(window, parent);
    }
    restack(leaf: NodeStack) {
        this.restacked.push(leaf);
    }
}

const at = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

function tree() {
    const workspaces = new FakeWorkspaces();
    return { workspaces, tree: new Tree(monitorID(0), workspaces.all[0]!, true, workspaces) };
}

/** A root fork of windows 1 and 2 in a 1000×500 area */
function two_windows(orientation = Orientation.HORIZONTAL) {
    const fork = new Fork(links(), Node.window(1), Node.window(2), at(0, 0, 1000, 500), tree().tree, orientation);
    fork.tree.root = fork;
    return fork;
}

describe('Tree', () => {
    test('finds the index of its workspace, which stays put when others are removed', () => {
        const { workspaces, tree: r } = tree();
        assert.equal(r.index(), 0);
        assert.equal(r.is_on(workspaceID(0)), true);

        workspaces.all.unshift({ name: 'new' });
        assert.equal(r.index(), 1);
        assert.equal(r.is_on(workspaceID(1)), true);
    });

    test('says when its workspace is gone, and moves to another by index', () => {
        const { workspaces, tree: r } = tree();
        r.move_to(workspaceID(1));
        assert.equal(r.workspace, workspaces.all[1]);

        workspaces.all.splice(1, 1);
        assert.equal(r.index(), -1);
    });
});

describe('Fork.measure', () => {
    test('a branch keeps room for the minimum size of the other', () => {
        const layout = new FakeLayout();
        layout.minimums.set(2, [700, 0]);
        const fork = two_windows();
        fork.measure(layout, fork.area);
        assert.deepEqual(layout.placed.get(1), at(0, 0, 292, 500));
        assert.deepEqual(layout.placed.get(2), at(300, 0, 700, 500));
        assert.equal(fork.length_left, 296);
    });

    test('a fork node whose fork has left the tree places nothing', () => {
        const gone = new Fork(links(), Node.window(2), null, at(0, 0, 1, 1), tree().tree);
        gone.detached = true;
        const fork = new Fork(links(), Node.window(1), Node.fork(gone), at(0, 0, 1000, 500), tree().tree);
        fork.tree.root = fork;
        const layout = new FakeLayout();
        fork.measure(layout, fork.area);
        assert.deepEqual([...layout.placed.keys()], [1]);
    });

    test('splits its area in half between its branches, less the gap', () => {
        const layout = new FakeLayout();
        two_windows().measure(layout, at(0, 0, 1000, 500));
        assert.deepEqual(layout.placed.get(1), at(0, 0, 496, 500));
        assert.deepEqual(layout.placed.get(2), at(504, 0, 496, 500));
    });

    test("cuts a half pixel of an odd gap toward zero, as mutter's rectangles did", () => {
        const layout = new FakeLayout();
        Object.assign(layout, { gap_inner: 5, gap_inner_half: 2.5 });
        two_windows().measure(layout, at(0, 0, 1000, 500));
        assert.deepEqual(layout.placed.get(1), at(0, 0, 497, 500));
        assert.deepEqual(layout.placed.get(2), at(502, 0, 497, 500));
    });

    test('splits one above the other when vertical', () => {
        const layout = new FakeLayout();
        two_windows(Orientation.VERTICAL).measure(layout, at(0, 0, 1000, 500));
        assert.deepEqual(layout.placed.get(1), at(0, 0, 1000, 246));
        assert.deepEqual(layout.placed.get(2), at(0, 254, 1000, 246));
    });

    test('a split near the middle stays in the middle, and others snap to 32 pixels', () => {
        const near = two_windows();
        near.length_left = 520;
        const layout = new FakeLayout();
        near.measure(layout, near.area);
        assert.equal(layout.placed.get(1)?.width, 496);

        const down = two_windows();
        down.length_left = 300;
        down.measure(layout, down.area);
        assert.equal(layout.placed.get(1)?.width, 288 - 4);

        const up = two_windows();
        up.length_left = 310;
        up.measure(layout, up.area);
        assert.equal(layout.placed.get(1)?.width, 320 - 4);
    });

    test('a fork with one branch gives it all of its area', () => {
        const fork = new Fork(links(), Node.window(1), null, at(0, 0, 1000, 500), tree().tree);
        fork.tree.root = fork;
        const layout = new FakeLayout();
        fork.measure(layout, fork.area);
        assert.deepEqual(layout.placed.get(1), at(0, 0, 1000, 500));
    });

    test('a fork below the top keeps its ratio in its new area', () => {
        const fork = new Fork(links(), Node.window(1), Node.window(2), at(0, 0, 1000, 500), tree().tree);
        fork.length_left = 250;
        const layout = new FakeLayout();
        fork.measure(layout, at(0, 0, 2000, 500));
        assert.equal(fork.length_left, 500);
        assert.deepEqual(fork.area, at(0, 0, 2000, 500));
    });

    test('a tabbed leaf keeps room for its tab bar, and asks for it to be placed', () => {
        const stacked = Node.window(1);
        stacked.inner.tabbed = true;
        stacked.inner.windows = [1, 3];
        const fork = new Fork(links(), stacked, Node.window(2), at(0, 0, 1000, 500), tree().tree);
        fork.tree.root = fork;
        const layout = new FakeLayout();

        fork.measure(layout, fork.area);

        assert.deepEqual(layout.placed.get(1), at(0, 20, 496, 480));
        assert.deepEqual(layout.placed.get(3), at(0, 20, 496, 480));
        assert.deepEqual(layout.restacked, [stacked.inner]);
    });

    test('a nested fork is measured in its branch', () => {
        const inner = new Fork(
            links(),
            Node.window(2),
            Node.window(3),
            at(0, 0, 1, 1),
            tree().tree,
            Orientation.VERTICAL,
        );
        const fork = new Fork(links(), Node.window(1), Node.fork(inner), at(0, 0, 1000, 500), tree().tree);
        fork.tree.root = fork;
        const layout = new FakeLayout();

        fork.measure(layout, fork.area);

        assert.deepEqual(layout.placed.get(2), at(504, 0, 496, 246));
        assert.deepEqual(layout.placed.get(3), at(504, 254, 496, 246));
        assert.equal(layout.parents.get(2), inner);
    });
});

describe('Fork', () => {
    test('finds the branch that holds a window, alone or in a stack', () => {
        const stacked = Node.window(2);
        stacked.inner.tabbed = true;
        stacked.inner.windows = [2, 3];
        const fork = new Fork(links(), Node.window(1), stacked, at(0, 0, 1000, 500), tree().tree);
        assert.equal(fork.find_branch(1), fork.left);
        assert.equal(fork.find_branch(3), fork.right);
        assert.equal(fork.find_branch(9), null);
    });

    describe('replace_window', () => {
        /** Tab bars that remember which leaves were drawn again */
        class FakeTabBars implements TabBars {
            updated: Array<NodeStack> = [];
            update(leaf: NodeStack) {
                this.updated.push(leaf);
            }
        }

        test('puts another window in the place of a lone one, once called', () => {
            const fork = two_windows();
            const replace = fork.replace_window(new FakeTabBars(), 2, 9);
            assert.ok(replace);
            assert.equal(fork.right?.is_window(2), true);

            replace();
            assert.equal(fork.right?.is_window(9), true);
        });

        test('in a stack, also draws its tab bar again', () => {
            const stacked = Node.window(1);
            stacked.inner.tabbed = true;
            stacked.inner.windows = [1, 3];
            const fork = new Fork(links(), stacked, Node.window(2), at(0, 0, 1000, 500), tree().tree);
            const tabs = new FakeTabBars();

            fork.replace_window(tabs, 3, 9)?.();

            assert.deepEqual(stacked.inner.windows, [1, 9]);
            assert.deepEqual(tabs.updated, [stacked.inner]);
        });

        test('nothing for a window that is in neither branch', () => {
            assert.equal(two_windows().replace_window(new FakeTabBars(), 9, 8), null);
        });
    });

    test('the areas of its branches are split at its left length, less the gap', () => {
        const fork = two_windows();
        fork.length_left = 600;
        const sizes = new LayoutSizes(1);
        sizes.set_gap_inner(2);
        assert.deepEqual(fork.area_of_left(sizes), at(0, 0, 596, 500));
        assert.deepEqual(fork.area_of_right(sizes), at(604, 0, 396, 500));
    });

    test('set_ratio keeps both branches at least 256 pixels', () => {
        const fork = two_windows();
        assert.equal(fork.set_ratio(100).length_left, 256);
        assert.equal(fork.set_ratio(900).length_left, 1000 - 256);
        assert.equal(fork.set_ratio(400.4).length_left, 400);
    });

    test('toggling the orientation swaps the branches every second time', () => {
        const fork = two_windows();
        const [left, right] = [fork.left, fork.right];

        fork.toggle_orientation();
        assert.equal(fork.orientation, Orientation.VERTICAL);
        assert.equal(fork.left, left);

        fork.toggle_orientation();
        assert.equal(fork.orientation, Orientation.HORIZONTAL);
        assert.equal(fork.left, right);
        assert.equal(fork.right, left);
    });

    test('rebalancing splits along the longer side', () => {
        const fork = new Fork(links(), Node.window(1), Node.window(2), at(0, 0, 500, 1000), tree().tree);
        fork.rebalance_orientation();
        assert.equal(fork.orientation, Orientation.VERTICAL);
        assert.equal(fork.orientation_changed, true);
    });
});
