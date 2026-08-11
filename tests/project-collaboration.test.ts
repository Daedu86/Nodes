import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  canEditProject,
  canManageProjectStructure,
  createProjectForUser,
  getProjectForUser,
  listProjectsForUser,
  patchProjectForUser,
  ProjectAccessError,
  removeProjectMemberForUser,
  toProjectActor,
  upsertProjectMemberForUser,
} from "../lib/project-collaboration";
import { createMemoryItem } from "../lib/memory-store";
import { createProject, upsertProjectMember } from "../lib/project-store";
import { createSession } from "../lib/session-store";

const owner = {
  email: "owner@example.com",
  id: "owner-1",
  name: "Owner",
};

const editor = {
  email: "editor@example.com",
  id: "editor-1",
  name: "Editor",
};

const viewer = {
  email: "viewer@example.com",
  id: "viewer-1",
  name: "Viewer",
};

describe("project collaboration", () => {
  let projectDir = "";
  let sessionDir = "";
  let memoryDir = "";
  const originalBackend = process.env.NODES_PERSISTENCE_BACKEND;
  const originalProjectStoreDir = process.env.PROJECT_STORE_DIR;
  const originalSessionStoreDir = process.env.SESSION_STORE_DIR;
  const originalMemoryStoreDir = process.env.PROJECT_MEMORY_STORE_DIR;

  beforeEach(async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "nodes-project-collab-projects-"));
    sessionDir = await mkdtemp(path.join(os.tmpdir(), "nodes-project-collab-sessions-"));
    memoryDir = await mkdtemp(path.join(os.tmpdir(), "nodes-project-collab-memory-"));
    process.env.NODES_PERSISTENCE_BACKEND = "file";
    process.env.PROJECT_STORE_DIR = projectDir;
    process.env.SESSION_STORE_DIR = sessionDir;
    process.env.PROJECT_MEMORY_STORE_DIR = memoryDir;
  });

  afterEach(async () => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };

    restore("NODES_PERSISTENCE_BACKEND", originalBackend);
    restore("PROJECT_STORE_DIR", originalProjectStoreDir);
    restore("SESSION_STORE_DIR", originalSessionStoreDir);
    restore("PROJECT_MEMORY_STORE_DIR", originalMemoryStoreDir);

    await Promise.all([
      projectDir ? rm(projectDir, { recursive: true, force: true }) : Promise.resolve(),
      sessionDir ? rm(sessionDir, { recursive: true, force: true }) : Promise.resolve(),
      memoryDir ? rm(memoryDir, { recursive: true, force: true }) : Promise.resolve(),
    ]);
  });

  it("maps users to project actors and evaluates role capabilities", () => {
    expect(toProjectActor(owner)).toEqual({
      userEmail: owner.email,
      userId: owner.id,
    });
    expect(
      toProjectActor({ email: null, id: "agent-1", isAgent: true, name: null }),
    ).toEqual({
      userEmail: null,
      userId: "agent-1",
    });

    expect(canEditProject({ accessRole: "owner" })).toBe(true);
    expect(canEditProject({ accessRole: "editor" })).toBe(true);
    expect(canEditProject({ accessRole: "viewer" })).toBe(false);
    expect(canManageProjectStructure({ accessRole: "owner" })).toBe(true);
    expect(canManageProjectStructure({ accessRole: "editor" })).toBe(false);
    expect(canManageProjectStructure({ accessRole: "viewer" })).toBe(false);
  });

  it("hydrates shared projects with attached sessions and typed nodes for viewers", async () => {
    const session = await createSession({
      ownerId: owner.id,
      title: "Exploration session",
    });
    const memory = await createMemoryItem({
      content: "Shared synthesis",
      ownerId: owner.id,
      title: "Shared summary",
      type: "summary",
    });
    const project = await createProject({
      memoryIds: [memory.id],
      ownerId: owner.id,
      sessionIds: [session.id],
      title: "Collaborative review",
    });

    await upsertProjectMember(
      project.id,
      {
        email: viewer.email,
        role: "viewer",
      },
      owner.id,
    );

    const sharedProject = await getProjectForUser(project.id, viewer);
    expect(sharedProject.accessRole).toBe("viewer");
    expect(sharedProject.members).toEqual([
      expect.objectContaining({
        email: viewer.email,
        role: "viewer",
      }),
    ]);
    expect(sharedProject.sessions?.map((entry) => entry.id)).toEqual([session.id]);
    expect(sharedProject.attachedMemoryItems?.map((entry) => entry.id)).toEqual([
      memory.id,
    ]);
  });

  it("lets editors update shared context but blocks structural changes", async () => {
    const project = await createProject({
      globalContext: "Initial context",
      ownerId: owner.id,
      title: "Editable project",
    });

    await upsertProjectMember(
      project.id,
      {
        email: editor.email,
        role: "editor",
      },
      owner.id,
    );

    const updated = await patchProjectForUser(
      project.id,
      {
        globalContext: "Updated by editor",
        title: "Updated title",
      },
      editor,
    );

    expect(updated.accessRole).toBe("editor");
    expect(updated.globalContext).toBe("Updated by editor");
    expect(updated.title).toBe("Updated title");

    await expect(
      patchProjectForUser(project.id, { sessionIds: ["session-1"] }, editor),
    ).rejects.toMatchObject({
      message: "Only the project owner can change the project map, attached sessions, or typed nodes.",
      status: 403,
    });
  });

  it("blocks viewers from editing project content", async () => {
    const project = await createProject({ ownerId: owner.id, title: "Read only" });
    await upsertProjectMember(
      project.id,
      { email: viewer.email, role: "viewer" },
      owner.id,
    );

    await expect(
      patchProjectForUser(project.id, { title: "Unauthorized change" }, viewer),
    ).rejects.toMatchObject({
      message: "You do not have permission to edit this project.",
      status: 403,
    });
  });

  it("lets owners create, list, and change project structure", async () => {
    const session = await createSession({ ownerId: owner.id, title: "Owner session" });
    const memory = await createMemoryItem({
      content: "Owner memory",
      ownerId: owner.id,
      title: "Owner memory",
      type: "summary",
    });
    const project = await createProjectForUser({ title: "Owner project" }, owner);

    const updated = await patchProjectForUser(
      project.id,
      {
        memoryIds: [memory.id],
        sessionIds: [session.id],
      },
      owner,
    );

    expect(updated.accessRole).toBe("owner");
    expect(updated.memoryIds).toEqual([memory.id]);
    expect(updated.sessionIds).toEqual([session.id]);
    expect(updated.attachedMemoryItems?.map((entry) => entry.id)).toEqual([
      memory.id,
    ]);
    expect(updated.sessions?.map((entry) => entry.id)).toEqual([session.id]);

    await expect(listProjectsForUser(owner)).resolves.toEqual([
      expect.objectContaining({ id: project.id, title: "Owner project" }),
    ]);
  });

  it("lets only owners update and remove accepted members", async () => {
    const project = await createProject({ ownerId: owner.id, title: "Managed project" });
    await upsertProjectMember(
      project.id,
      { email: editor.email, role: "viewer" },
      owner.id,
    );

    const updated = await upsertProjectMemberForUser(
      project.id,
      { email: " EDITOR@EXAMPLE.COM ", role: "editor" },
      owner,
    );
    expect(updated.members).toEqual([
      expect.objectContaining({ email: editor.email, role: "editor" }),
    ]);

    await expect(
      upsertProjectMemberForUser(
        project.id,
        { email: viewer.email, role: "viewer" },
        editor,
      ),
    ).rejects.toBeInstanceOf(ProjectAccessError);
    await expect(
      removeProjectMemberForUser(project.id, editor.email, editor),
    ).rejects.toMatchObject({ status: 403 });

    const removed = await removeProjectMemberForUser(project.id, editor.email, owner);
    expect(removed.members).toEqual([]);
  });

  it("does not activate collaborators before invitation acceptance", async () => {
    const project = await createProject({ ownerId: owner.id });

    await expect(
      upsertProjectMemberForUser(
        project.id,
        { email: viewer.email, role: "viewer" },
        owner,
      ),
    ).rejects.toMatchObject({
      message:
        "New collaborators must accept a project invitation before membership is active.",
      status: 409,
    });
  });
});
