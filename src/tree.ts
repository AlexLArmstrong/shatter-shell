import type Meta from 'gi://Meta';

import type { Fork } from './fork.js';

export class Tree {
    readonly root: Fork;

    monitor: MonitorID;

    /** Not an index, which shifts when workspaces are added or removed */
    workspace: Meta.Workspace;

    on_primary_display: boolean;

    constructor(monitor: MonitorID, workspace: Meta.Workspace, make_root: (tree: Tree) => Fork) {
        this.monitor = monitor;
        this.workspace = workspace;
        this.on_primary_display = global.display.get_primary_monitor() === monitor;
        this.root = make_root(this);
    }

    move_to(workspace: Meta.Workspace) {
        this.workspace = workspace;
    }

    /** -1 once mutter has removed the workspace */
    index(): number {
        const manager = global.workspace_manager;
        for (let index = 0; index < manager.get_n_workspaces(); index += 1) {
            if (manager.get_workspace_by_index(index) === this.workspace) return index;
        }
        return -1;
    }

    is_on(workspace: WorkspaceID): boolean {
        return global.workspace_manager.get_workspace_by_index(workspace) === this.workspace;
    }
}
