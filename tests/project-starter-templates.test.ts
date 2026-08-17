import { describe, expect, it } from "vitest";
import {
  PROJECT_STARTER_TEMPLATES,
  getProjectStarterTemplate,
} from "@/lib/project-starter-templates";
import { normalizeProjectMap } from "@/lib/project-map";

describe("project starter templates", () => {
  it("ships four reusable, valid project maps", () => {
    expect(PROJECT_STARTER_TEMPLATES.map((template) => template.id)).toEqual([
      "product-discovery",
      "research-synthesis",
      "technical-design",
      "writing",
    ]);

    for (const template of PROJECT_STARTER_TEMPLATES) {
      const map = template.create();
      expect(map.nodes.length).toBeGreaterThanOrEqual(5);
      expect(map.edges).toHaveLength(map.nodes.length - 1);
      expect(normalizeProjectMap(map)).toEqual(map);
    }
  });

  it("looks up templates by stable id", () => {
    expect(getProjectStarterTemplate("technical-design")?.title).toBe("Technical design");
  });
});
