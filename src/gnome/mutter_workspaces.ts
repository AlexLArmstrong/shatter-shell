import type { WorkspaceList } from '../core/fork.js';

/** The workspaces as mutter has them now */
export class MutterWorkspaces implements WorkspaceList {
    index_of(workspace: object): number {
        const manager = global.workspace_manager;
        for (let index = 0; index < manager.get_n_workspaces(); index += 1) {
            if (manager.get_workspace_by_index(index) === workspace) return index;
        }

        return -1;
    }

    at(index: number): object | null {
        return global.workspace_manager.get_workspace_by_index(index);
    }
}
