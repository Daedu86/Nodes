import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
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
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Workspace artifact path traverses a symbolic link: ${relative}`);
    }
  }
}

function readExistingRegularFile(target, relativePath) {
  let fd;
  try {
    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Workspace artifact target is not a regular file: ${relativePath}`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function assertMatchingExistingFile(file, current) {
  if (current !== file.content) {
    throw new Error(
      `Workspace artifact conflict: ${file.path} differs from the authoritative primary-session artifact.`,
    );
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

    const current = readExistingRegularFile(target, file.path);
    if (current !== null) {
      assertMatchingExistingFile(file, current);
      unchanged += 1;
      continue;
    }

    try {
      writeFileSync(target, file.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      created += 1;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const raced = readExistingRegularFile(target, file.path);
      if (raced === null) throw error;
      assertMatchingExistingFile(file, raced);
      unchanged += 1;
    }
  }

  return {
    count: files.length,
    created,
    unchanged,
    paths: files.map((file) => file.path),
  };
}