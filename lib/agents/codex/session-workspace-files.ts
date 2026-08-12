import type { CodexWorkspaceFile } from "@/lib/agents/codex/types";
import type { SessionArtifact } from "@/lib/session-artifacts";

const MAX_WORKSPACE_FILES = 32;
const MAX_SINGLE_FILE_CHARS = 256_000;
const MAX_TOTAL_FILE_CHARS = 512_000;

const normalizeWorkspaceArtifactPath = (value: string | null | undefined) => {
  const raw = typeof value === "string" ? value.trim().replaceAll("\\", "/") : "";
  if (!raw || !raw.startsWith(".nodes/")) return null;
  if (raw.includes("\0")) return null;
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return raw;
};

export const buildSessionWorkspaceFiles = (
  artifacts: SessionArtifact[],
): CodexWorkspaceFile[] => {
  const files: CodexWorkspaceFile[] = [];
  const byPath = new Map<string, string>();
  let totalChars = 0;

  for (const artifact of artifacts) {
    const filePath = normalizeWorkspaceArtifactPath(artifact.fileName);
    if (!filePath || !artifact.content) continue;
    if (artifact.content.length > MAX_SINGLE_FILE_CHARS) {
      throw new Error(`Session execution artifact is too large to materialize: ${filePath}`);
    }

    const existing = byPath.get(filePath);
    if (existing !== undefined) {
      if (existing !== artifact.content) {
        throw new Error(`Conflicting primary-session artifacts target the same workspace file: ${filePath}`);
      }
      continue;
    }

    totalChars += artifact.content.length;
    if (totalChars > MAX_TOTAL_FILE_CHARS) {
      throw new Error("Primary-session execution artifacts exceed the workspace materialization budget.");
    }
    if (files.length >= MAX_WORKSPACE_FILES) {
      throw new Error("Primary-session execution artifacts exceed the workspace file-count budget.");
    }

    byPath.set(filePath, artifact.content);
    files.push({
      artifactId: artifact.id,
      content: artifact.content,
      mimeType: artifact.mimeType ?? null,
      path: filePath,
    });
  }

  return files;
};

export const isTychoProtocolWorkspaceFile = (file: CodexWorkspaceFile) =>
  file.path === ".nodes/tycho-experiment.json";

export const hasTychoProtocolWorkspaceFile = (files: CodexWorkspaceFile[]) =>
  files.some(isTychoProtocolWorkspaceFile);
