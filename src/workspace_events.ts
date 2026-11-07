/**
 * Works out what happened to the workspaces from how things are, rather than from mutter's signals.
 *
 * Mutter and GNOME Shell report a change to the workspaces as many separate signals: one for each
 * window they move, and one for a workspace added or removed. Which of these arrive, and in which
 * order, is up to them, and may change between versions. So the signals only ask for an analysis
 * once they have settled, and the analysis only compares the trees with where mutter has their
 * windows by then, and says what happened as a few internal events.
 *
 * Each kind of change that is recognized has a small recognizer of its own below, which can be
 * reasoned about, changed or dropped on its own, such as if GNOME Shell changes how it inserts a
 * workspace. Whatever no recognizer explains falls through as windows that moved on their own,
 * which is always a correct way to handle it, if not always the one that keeps layouts.
 *
 * Nothing here talks to mutter, which the auto-tiler does when it takes the snapshot and applies
 * the events.
 */

import type Meta from 'gi://Meta';

import type { Fork } from './fork.js';
import type { ShellWindow } from './window.js';

/** Where mutter has a window of a tree */
export interface WindowState {
    window: ShellWindow;
    workspace: Meta.Workspace;
    /** The index of its workspace, or -1 if that workspace has been removed */
    index: number;
}

/** A tree, and where mutter has each of its windows that is on one workspace */
export interface TreeState {
    fork: Fork;
    /** The index of the tree's workspace, or -1 if that workspace has been removed */
    index: number;
    windows: Array<WindowState>;
}

export type WorkspaceEvent =
    /**
     * A workspace was inserted, and each of these trees, whose windows all moved on by one, moves on
     * to the workspace at this index with them.
     */
    | { kind: 'inserted'; trees: Array<[Fork, number]> }
    /** The tree's workspace was removed, and mutter moved all of its windows to this one */
    | { kind: 'removed'; fork: Fork; to: Meta.Workspace }
    /** The window is on another workspace than its tree, and nothing else explains it */
    | { kind: 'window_moved'; window: ShellWindow };

/** What the recognizers have worked out so far */
interface Findings {
    /** The windows that the events found so far explain, which don't fall through on their own */
    explained: Set<ShellWindow>;
    /** The index of the workspace that each tree moves to, if it moves */
    moves: Map<Fork, number>;
}

/** Looks for one kind of change in the trees, and returns the events that it recognizes */
type Recognizer = (trees: Array<TreeState>, findings: Findings) => Array<WorkspaceEvent>;

/**
 * Mutter moves the windows of a removed workspace to a neighbour, before it says that the workspace
 * was removed. A tree whose workspace is gone, and whose windows are all on one other workspace now,
 * has had its workspace removed. If its windows haven't been moved yet, nothing has happened to it.
 */
const removed: Recognizer = (trees, { explained, moves }) => {
    const events: Array<WorkspaceEvent> = [];

    for (const tree of trees) {
        const [first] = tree.windows;
        if (tree.index !== -1 || !first || first.index === -1) continue;
        if (!tree.windows.every(window => window.workspace === first.workspace)) continue;

        events.push({ kind: 'removed', fork: tree.fork, to: first.workspace });
        moves.set(tree.fork, first.index);
        for (const window of tree.windows) explained.add(window.window);
    }

    return events;
};

/**
 * GNOME Shell makes room for a window that is dropped between two workspaces in the overview by
 * adding a workspace at the end, and moving every window from the one at the drop on to the next,
 * except windows on all workspaces. Then it moves the dropped window to the workspace that this
 * freed. So from some index on, every tree has all of its windows one workspace further on, the
 * trees before it have theirs where they are, and at most one window, the dropped one, is on the
 * freed workspace instead.
 *
 * Only that exact pattern is recognized, so that nothing else is mistaken for it. The trees then
 * move on together, keeping their layouts, and the dropped window falls through as moved on its own.
 *
 * The dropped window may come from the tree just before the drop, and then lands one workspace on
 * from it, which also fits a drop one workspace earlier. So the latest drop that fits is taken,
 * which moves the fewest trees.
 */
const inserted: Recognizer = (trees, { explained, moves }) => {
    const live = trees.filter(tree => tree.index !== -1 && tree.windows.length > 0);
    const moved_on = (tree: TreeState) => tree.windows.filter(window => window.index === tree.index + 1);

    const candidates = new Set(live.filter(tree => moved_on(tree).length > 0).map(tree => tree.index));
    for (const at of Array.from(candidates).sort((a, b) => b - a)) {
        if (!inserted_at(live, at)) continue;

        const moving = live.filter(tree => tree.index >= at && moved_on(tree).length > 0);
        for (const tree of moving) {
            moves.set(tree.fork, tree.index + 1);
            for (const window of moved_on(tree)) explained.add(window.window);
        }

        return [{ kind: 'inserted', trees: moving.map(tree => [tree.fork, tree.index + 1]) }];
    }

    return [];
};

/**
 * Whether the trees fit a workspace inserted at this index: every window of a tree from there on is
 * one workspace further on, every window of a tree before it is where it was, and at most one window,
 * the dropped one, is on the inserted workspace instead.
 */
function inserted_at(live: Array<TreeState>, at: number): boolean {
    let stray = 0;
    for (const tree of live) {
        const expected = tree.index >= at ? tree.index + 1 : tree.index;
        for (const window of tree.windows) {
            if (window.index === expected) continue;
            if (window.index !== at) return false;
            stray += 1;
        }
    }

    return stray <= 1;
}

/** The recognizers, in the order in which they're tried */
const RECOGNIZERS: Array<Recognizer> = [removed, inserted];

/**
 * Says what happened to the workspaces, given where each tree is and where mutter has its windows.
 * The events come in the order of the recognizers, and windows that moved on their own come last.
 */
export function analyze(trees: Array<TreeState>): Array<WorkspaceEvent> {
    const events: Array<WorkspaceEvent> = [];
    const findings: Findings = { explained: new Set(), moves: new Map() };

    for (const recognize of RECOGNIZERS) events.push(...recognize(trees, findings));

    // Each window that is still on another workspace than its tree ends up on moved on its own
    for (const tree of trees) {
        const index = findings.moves.get(tree.fork) ?? tree.index;
        for (const window of tree.windows) {
            if (!findings.explained.has(window.window) && window.index !== index) {
                events.push({ kind: 'window_moved', window: window.window });
            }
        }
    }

    return events;
}
