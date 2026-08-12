import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const MAX_WORKSPACE_FILES = 32;
const MAX_SINGLE_FILE_BYTES = 256_000;
const MAX_TOTAL_FILE_BYTES = 512_000;

const asString = (value) => (typeof value === "string" ? value : null);

function normalizeRelativePath(value) {
  const raw = asString(value)?.trim().replaceAll("\\", "/") || "";
  if (!raw || !raw.startsWith(".nodes/") || raw.includes("\0")) {
    throw new Error("Runner workspace artifacts must use an explicit .nodes/ relative path.");
  }
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid runner workspace artifact path: ${raw}`);
  }
  if (raw.length > 240) {
    throw new Error(`Runner workspace artifact path is too long: ${raw}`);
  }
  return raw;
}

export function normalizeWorkspaceFiles(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("workspaceFiles must be an array.");
  if (value.length > MAX_WORKSPACE_FILES) {
    throw new Error("workspaceFiles exceeds the runner file-count budget.");
  }

  const files = [];
  const seen = new Map();
  let totalBytes = 0;

  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("workspaceFiles contains an invalid entry.");
    }
    const relativePath = normalizeRelativePath(entry.path);
    const content = asString(entry.content);
    if (content === null) throw new Error(`Workspace artifact content must be text: ${relativePath}`);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_SINGLE_FILE_BYTES) {
      throw new Error(`Workspace artifact exceeds the per-file budget: ${relativePath}`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_FILE_BYTES) {
      throw new Error("workspaceFiles exceeds the runner total-byte budget.");
    }

    const previous = seen.get(relativePath);
    if (previous !== undefined) {
      if (previous !== content) {
        throw new Error(`Conflicting workspace artifacts target the same path: ${relativePath}`);
      }
      continue;
    }
    seen.set(relativePath, content);
    files.push({ path: relativePath, content });
  }

  return files;
}

function assertContainedPath(root, relativePath) {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Workspace artifact escaped the configured workspace: ${relativePath}`);
  }
  return target;
}

function assertNoSymlinkComponents(root, target) {
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Workspace artifact path traverses a symbolic link: ${relative}`);
    }
  }
}

export function materializeWorkspaceFiles(cwd, value) {
  const root = path.resolve(cwd);
  const files = normalizeWorkspaceFiles(value);
  let created = 0;
  let unchanged = 0;

  for (const file of files) {
    const target = assertContainedPath(root, file.path);
    const parent = path.dirname(target);
    assertNoSymlinkComponents(root, parent);
    mkdirSync(parent, { recursive: true });
    assertNoSymlinkComponents(root, parent);

    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Workspace artifact target is not a regular file: ${file.path}`);
      }
      const current = readFileSync(target, "utf8");
      if (current !== file.content) {
        throw new Error(
          `Workspace artifact conflict: ${file.path} differs from the authoritative primary-session artifact.`,
        );
      }
      unchanged += 1;
      continue;
    }

    writeFileSync(target, file.content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    created += 1;
  }

  return {
    count: files.length,
    created,
    unchanged,
    paths: files.map((file) => file.path),
  };
}
