import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    Node,
    type NodeStack,
    stack_activate,
    stack_insert,
    stack_move_left,
    stack_move_right,
    stack_remove,
    stack_replace,
    type TabBars,
} from '../src/core/node.js';

/** Tab bars that count how often a leaf was drawn again */
class FakeTabBars implements TabBars {
    updates = 0;
    update() {
        this.updates += 1;
    }
}

/** A tabbed leaf of these windows, with the first one active */
function stack_of(...windows: Array<number>): NodeStack {
    const leaf = Node.window(windows[0]!).inner;
    leaf.tabbed = true;
    leaf.windows = [...windows];
    return leaf;
}

describe('Node', () => {
    test('a window is a leaf of one window, without tabs', () => {
        const leaf = Node.window(1);
        assert.equal(leaf.is_leaf(), true);
        assert.equal(leaf.has(1), true);
        assert.equal(leaf.has(2), false);
        assert.equal(leaf.is_in_stack(1), false);
        assert.equal(leaf.lone_window(), 1);
    });

    test('a tabbed leaf holds its windows in a stack, and has no lone window', () => {
        const leaf = new Node(stack_of(1, 2));
        assert.equal(leaf.is_in_stack(2), true);
        assert.equal(leaf.lone_window(), null);
    });
});

describe('the stack functions', () => {
    test('insert adds at either end, and draws the stack again', () => {
        const tabs = new FakeTabBars();
        const leaf = stack_of(1, 2);
        stack_insert(tabs, leaf, 3, true);
        stack_insert(tabs, leaf, 0, false);
        assert.deepEqual(leaf.windows, [0, 1, 2, 3]);
        assert.equal(tabs.updates, 2);
    });

    test('activate shows a window of the stack and remembers the one before', () => {
        const tabs = new FakeTabBars();
        const leaf = stack_of(1, 2);
        stack_activate(tabs, leaf, 2);
        assert.equal(leaf.active, 2);
        assert.equal(leaf.prev_active, 1);

        stack_activate(tabs, leaf, 9);
        assert.equal(leaf.active, 2);
        assert.equal(tabs.updates, 1);
    });

    test('removing the active window shows the one before it, if it is still there', () => {
        const tabs = new FakeTabBars();
        const leaf = stack_of(1, 2, 3);
        stack_activate(tabs, leaf, 3);
        assert.equal(stack_remove(tabs, leaf, 3), 2);
        assert.deepEqual(leaf.windows, [1, 2]);
        assert.equal(leaf.active, 1);
        assert.equal(leaf.prev_active, null);
    });

    test('otherwise the window that takes its place', () => {
        const tabs = new FakeTabBars();
        const leaf = stack_of(1, 2, 3);
        stack_remove(tabs, leaf, 1);
        assert.equal(leaf.active, 2);

        const last = stack_of(1, 2);
        stack_activate(tabs, last, 2);
        last.prev_active = null;
        stack_remove(tabs, last, 2);
        assert.equal(last.active, 1);
    });

    test('removing a window that is not there changes nothing', () => {
        const tabs = new FakeTabBars();
        assert.equal(stack_remove(tabs, stack_of(1), 9), null);
        assert.equal(tabs.updates, 0);
    });

    test('replace puts another window in its place, active if it was', () => {
        const tabs = new FakeTabBars();
        const leaf = stack_of(1, 2);
        stack_replace(tabs, leaf, 1, 7);
        assert.deepEqual(leaf.windows, [7, 2]);
        assert.equal(leaf.active, 7);
    });

    test('moving left and right swaps with the neighbour, and removes the window at the end', () => {
        const tabs = new FakeTabBars();
        const leaf = stack_of(1, 2, 3);
        assert.equal(stack_move_left(tabs, leaf, 2), true);
        assert.deepEqual(leaf.windows, [2, 1, 3]);
        assert.equal(stack_move_right(tabs, leaf, 1), true);
        assert.deepEqual(leaf.windows, [2, 3, 1]);

        assert.equal(stack_move_right(tabs, leaf, 1), false);
        assert.deepEqual(leaf.windows, [2, 3]);
        assert.equal(stack_move_left(tabs, leaf, 2), false);
        assert.deepEqual(leaf.windows, [3]);
    });
});
