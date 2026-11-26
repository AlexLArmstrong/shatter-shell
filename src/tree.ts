import type { Fork } from './fork.js';

export class Tree {
    readonly root: Fork;

    monitor: MonitorID;
    workspace: WorkspaceID;
    on_primary_display: boolean;

    constructor(monitor: MonitorID, workspace: WorkspaceID, make_root: (tree: Tree) => Fork) {
        this.monitor = monitor;
        this.workspace = workspace;
        this.on_primary_display = global.display.get_primary_monitor() === monitor;
        this.root = make_root(this);
    }
}
