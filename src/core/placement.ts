/**
 * Where a window goes when it's dropped onto another one, or moved next to it.
 */

import type { MoveByCursor } from './forest.js';

import { nearest_side, type Rect, Side } from './geom.js';
import { Orientation } from './orientation.js';

export enum Direction {
    Left,
    Up,
    Right,
    Down,
}

/**
 * Where a window dropped at `pointer` on `area` goes: beside it, on the side nearest to the pointer.
 * Null means into a stack with it, which only happens at the center, while stacking with the mouse.
 */
export function drop_placement(
    area: Rect,
    pointer: [x: number, y: number],
    stacking_with_mouse: boolean,
): MoveByCursor | null {
    switch (nearest_side(pointer, area, stacking_with_mouse).side) {
        case Side.LEFT:
            return { orientation: Orientation.HORIZONTAL, swap: true };
        case Side.RIGHT:
            return { orientation: Orientation.HORIZONTAL, swap: false };
        case Side.TOP:
            return { orientation: Orientation.VERTICAL, swap: true };
        case Side.BOTTOM:
            return { orientation: Orientation.VERTICAL, swap: false };
        case Side.CENTER:
            return null;
    }
}

/** The direction from the window dropped onto in which a placement puts the dropped one */
export function direction_of(placement: MoveByCursor): Direction {
    if (placement.orientation === Orientation.HORIZONTAL) return placement.swap ? Direction.Left : Direction.Right;
    return placement.swap ? Direction.Up : Direction.Down;
}

/**
 * Whether a fork's branches swap, so that a window that's on its left, or not, ends up on the side
 * of `direction`
 */
export function swaps(is_left: boolean, direction: Direction): boolean {
    return is_left
        ? direction === Direction.Right || direction === Direction.Down
        : direction === Direction.Left || direction === Direction.Up;
}

/** What dropping a window onto another one does */
export type DropAction =
    /** The window leaves its stack, which the window dropped onto is in too, in the direction */
    | { kind: 'move_from_stack'; direction: Direction }
    /** The window goes next to the stack that the window dropped onto is in, in the direction */
    | { kind: 'move_alongside_stack'; direction: Direction }
    /** The window and its sibling turn to the placement's orientation, the window to its direction */
    | { kind: 'swap'; placement: MoveByCursor; direction: Direction }
    /** The window joins the tree of a lone window beside it, then turns as above */
    | { kind: 'attach_and_swap'; placement: MoveByCursor; direction: Direction }
    /** The window was dropped into its own stack, so its tree is only tiled again */
    | { kind: 'retile' }
    /** The window joins a stack with the window dropped onto, which gets tabs if it has none */
    | { kind: 'stack' }
    /** The window goes beside the window dropped onto, as the placement says */
    | { kind: 'attach'; placement: MoveByCursor };

/** What's known about a window dropped onto a target window */
export interface Drop {
    /** Where it goes beside the target, or null for into a stack with it */
    placement: MoveByCursor | null;
    /** Whether the target is in a stack, as the tree says */
    target_stacked: boolean;
    /** Whether the target is in a stack, as its window says */
    target_in_stack: boolean;
    /** Whether the window is in the same stack as the target */
    same_stack: boolean;
    in_stack: boolean;
    /** Whether the window and the target share a fork */
    sibling: boolean;
    /** Whether the target is alone in its tree */
    lone_tree: boolean;
}

export function drop_action(drop: Drop): DropAction {
    const { placement } = drop;
    if (placement === null) return drop.same_stack ? { kind: 'retile' } : { kind: 'stack' };

    const direction = direction_of(placement);

    if (drop.target_stacked) {
        if (drop.same_stack) return { kind: 'move_from_stack', direction };
        if (drop.target_in_stack) {
            return drop.sibling && !drop.in_stack
                ? { kind: 'swap', placement, direction }
                : { kind: 'move_alongside_stack', direction };
        }
    } else if (drop.sibling && !drop.in_stack) {
        return { kind: 'swap', placement, direction };
    } else if (drop.lone_tree) {
        return { kind: 'attach_and_swap', placement, direction };
    }

    return { kind: 'attach', placement };
}
