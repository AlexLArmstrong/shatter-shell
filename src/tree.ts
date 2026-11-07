export class Tree {
    monitor: MonitorID;
    workspace: WorkspaceID;
    on_primary_display: boolean;

    constructor(monitor: MonitorID, workspace: WorkspaceID) {
        this.monitor = monitor;
        this.workspace = workspace;
        this.on_primary_display = global.display.get_primary_monitor() === monitor;
    }
}
