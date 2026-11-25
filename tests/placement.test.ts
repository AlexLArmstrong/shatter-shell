import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Rect } from '../src/core/geom.js';

import { Orientation } from '../src/core/orientation.js';
import { Direction, type Drop, direction_of, drop_action, drop_placement, swaps } from '../src/core/placement.js';

const area: Rect = { x: 0, y: 0, width: 100, height: 100 };
const LEFT = { orientation: Orientation.HORIZONTAL, swap: true };
const RIGHT = { orientation: Orientation.HORIZONTAL, swap: false };
const TOP = { orientation: Orientation.VERTICAL, swap: true };
const BOTTOM = { orientation: Orientation.VERTICAL, swap: false };

/** A drop beside a window that is not stacked, sibling or alone */
function drop(changes: Partial<Drop> = {}): Drop {
    return {
        placement: RIGHT,
        target_stacked: false,
        target_in_stack: false,
        same_stack: false,
        in_stack: false,
        sibling: false,
        lone_tree: false,
        ...changes,
    };
}

describe('drop_placement', () => {
    test('a window goes beside the target, on the side nearest the pointer', () => {
        assert.deepEqual(drop_placement(area, [10, 50], false), LEFT);
        assert.deepEqual(drop_placement(area, [90, 50], false), RIGHT);
        assert.deepEqual(drop_placement(area, [50, 10], false), TOP);
        assert.deepEqual(drop_placement(area, [50, 90], false), BOTTOM);
    });

    test('at the center, it goes into a stack with it, while stacking with the mouse', () => {
        assert.equal(drop_placement(area, [50, 45], true), null);
        assert.notEqual(drop_placement(area, [50, 45], false), null);
    });
});

describe('direction_of and swaps', () => {
    test('a placement says in which direction the window goes', () => {
        assert.equal(direction_of(LEFT), Direction.Left);
        assert.equal(direction_of(RIGHT), Direction.Right);
        assert.equal(direction_of(TOP), Direction.Up);
        assert.equal(direction_of(BOTTOM), Direction.Down);
    });

    test('a fork swaps when the window is on the other side than the direction', () => {
        assert.equal(swaps(true, Direction.Right), true);
        assert.equal(swaps(true, Direction.Down), true);
        assert.equal(swaps(true, Direction.Left), false);
        assert.equal(swaps(false, Direction.Left), true);
        assert.equal(swaps(false, Direction.Up), true);
        assert.equal(swaps(false, Direction.Down), false);
    });
});

describe('drop_action', () => {
    test('into a stack: retile if it is its own, else stack with the target', () => {
        assert.deepEqual(drop_action(drop({ placement: null, same_stack: true })), { kind: 'retile' });
        assert.deepEqual(drop_action(drop({ placement: null })), { kind: 'stack' });
    });

    test('beside a window in its own stack, it leaves the stack in that direction', () => {
        assert.deepEqual(drop_action(drop({ target_stacked: true, same_stack: true })), {
            kind: 'move_from_stack',
            direction: Direction.Right,
        });
    });

    test('beside a window in another stack, it goes next to the stack, or swaps with it as its sibling', () => {
        const stacked = { target_stacked: true, target_in_stack: true };
        assert.deepEqual(drop_action(drop(stacked)), { kind: 'move_alongside_stack', direction: Direction.Right });
        assert.deepEqual(drop_action(drop({ ...stacked, sibling: true })), {
            kind: 'swap',
            placement: RIGHT,
            direction: Direction.Right,
        });
        assert.deepEqual(drop_action(drop({ ...stacked, sibling: true, in_stack: true })), {
            kind: 'move_alongside_stack',
            direction: Direction.Right,
        });
    });

    test('beside its sibling, a window that is not stacked swaps with it', () => {
        assert.deepEqual(drop_action(drop({ placement: TOP, sibling: true })), {
            kind: 'swap',
            placement: TOP,
            direction: Direction.Up,
        });
    });

    test('beside the lone window of a tree, it joins and turns to the placement', () => {
        assert.deepEqual(drop_action(drop({ lone_tree: true })), {
            kind: 'attach_and_swap',
            placement: RIGHT,
            direction: Direction.Right,
        });
    });

    test('otherwise it goes beside the target as the placement says', () => {
        assert.deepEqual(drop_action(drop({ placement: LEFT })), { kind: 'attach', placement: LEFT });
        assert.deepEqual(drop_action(drop({ placement: LEFT, sibling: true, in_stack: true })), {
            kind: 'attach',
            placement: LEFT,
        });
    });
});
