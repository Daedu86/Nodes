"use client";

import { ProjectExecutionRunnerPanel } from "@/components/workspace/project-execution-runner-panel";
import { ProjectWorkspaceView } from "@/components/workspace/project-workspace-view";
import { useProjectWorkspaceController } from "@/components/workspace/use-project-workspace-controller";

export function ProjectWorkspace() {
  const controller = useProjectWorkspaceController();
  if (!controller) return null;

  return (
    <div className="relative h-full min-h-0">
      <ProjectWorkspaceView {...controller} />
      {controller.workspaceMode === "canvas" ? (
        <ProjectExecutionRunnerPanel
          project={controller.activeProject}
          selection={controller.selectedCanvasItem}
        />
      ) : null}
    </div>
  );
}
