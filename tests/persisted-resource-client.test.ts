import { describe, expect, it } from "vitest";
import {
  buildActiveResourceStorageKey,
  dedupeResourceIds,
  prependUniqueResource,
  reconcileQueuedResourceIds,
  removeResourceById,
  replaceResourceById,
} from "@/lib/client/persisted-resource-client";

describe("persisted resource client helpers", () => {
  it("builds user-scoped and anonymous active-resource keys", () => {
    expect(buildActiveResourceStorageKey("session", "user-42")).toBe(
      "nodes.active-session-id.user-42",
    );
    expect(buildActiveResourceStorageKey("project", null)).toBe(
      "nodes.active-project-id.v1",
    );
  });

  it("deduplicates and removes empty resource ids", () => {
    expect(dedupeResourceIds(["a", "", "b", "a"])).toEqual(["a", "b"]);
  });

  it("preserves a queued addition that committed after a stale render", () => {
    expect(
      reconcileQueuedResourceIds(
        ["base-memory", "arena-memo"],
        ["base-memory", "arena-merge-node"],
      ),
    ).toEqual(["base-memory", "arena-memo", "arena-merge-node"]);
  });

  it("keeps pure removals subtractive instead of turning the list append-only", () => {
    expect(
      reconcileQueuedResourceIds(
        ["base-memory", "arena-memo", "arena-merge-node"],
        ["base-memory", "arena-merge-node"],
      ),
    ).toEqual(["base-memory", "arena-merge-node"]);
  });

  it("replaces known resources without changing list order", () => {
    expect(
      replaceResourceById(
        [
          { id: "a", value: 1 },
          { id: "b", value: 2 },
        ],
        { id: "b", value: 3 },
      ),
    ).toEqual([
      { id: "a", value: 1 },
      { id: "b", value: 3 },
    ]);
  });

  it("removes a resource by id without changing the remaining order", () => {
    expect(
      removeResourceById(
        [
          { id: "a", value: 1 },
          { id: "b", value: 2 },
          { id: "c", value: 3 },
        ],
        "b",
      ),
    ).toEqual([
      { id: "a", value: 1 },
      { id: "c", value: 3 },
    ]);
  });

  it("prepends a resource while removing an older copy", () => {
    expect(
      prependUniqueResource(
        [
          { id: "a", value: 1 },
          { id: "b", value: 2 },
        ],
        { id: "b", value: 4 },
      ),
    ).toEqual([
      { id: "b", value: 4 },
      { id: "a", value: 1 },
    ]);
  });
});