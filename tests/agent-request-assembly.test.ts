import { describe, expect, it } from "vitest";
import {
  AgentRequestAssembler,
  createAuthoritativeWorkloadSection,
} from "@/lib/agents/kernel/request-assembly";

describe("AgentRequestAssembler", () => {
  it("orders global and request-scoped sections and preserves a canonical header", () => {
    const assembler = new AgentRequestAssembler({
      createAssemblyId: () => "assembly-1",
    });
    assembler.registerSection({
      name: "identity",
      order: -100,
      text: "Nodes agent runtime",
    });

    const assembly = assembler.assemble({
      runtime: "codex",
      sessionId: "session-1",
      projectId: "project-1",
      role: "reviewer",
      prompt: "Review the change",
      model: "gpt-test",
      reasoningEffort: "high",
      workspacePaths: ["b.txt", "a.txt", "a.txt"],
      toolNames: ["shell", "read", "shell"],
      sections: [{
        name: "policy",
        order: 10,
        text: "Stay inside the authorized workload.",
      }],
    });

    expect(assembly.systemPrompt).toBe(
      "Nodes agent runtime\n\nStay inside the authorized workload.",
    );
    expect(assembly.effectivePrompt).toBe(
      "Review the change\n\nNodes agent runtime\n\nStay inside the authorized workload.",
    );
    expect(assembly.header).toMatchObject({
      assemblyId: "assembly-1",
      runtime: "codex",
      model: "gpt-test",
      reasoningEffort: "high",
      workspacePaths: ["a.txt", "b.txt"],
      toolNames: ["read", "shell"],
      sectionNames: ["identity", "policy"],
    });
  });

  it("allows a request-scoped section to shadow a global section", () => {
    const assembler = new AgentRequestAssembler({
      createAssemblyId: () => "assembly-2",
    });
    assembler.registerSection({ name: "persona", order: 0, text: "global" });

    const assembly = assembler.assemble({
      runtime: "nooa",
      sessionId: "session-2",
      prompt: "Do work",
      sections: [{ name: "persona", order: 0, text: "scoped" }],
    });

    expect(assembly.systemPrompt).toBe("scoped");
    expect(assembly.header.sectionNames).toEqual(["persona"]);
  });

  it("renders the authoritative workload scope deterministically", () => {
    const section = createAuthoritativeWorkloadSection([
      "z/input.json",
      "a/context.md",
      "z/input.json",
    ]);
    expect(section.text).toContain("- a/context.md\n- z/input.json");
  });
});
