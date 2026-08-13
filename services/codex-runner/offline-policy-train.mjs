import { createPolicyController } from "./policy-controller.mjs";
import { createTeamPolicyController } from "./team-policy-controller.mjs";
import { createTrajectoryStore } from "./trajectory-store.mjs";
import { createSkillRegistry } from "./skill-registry.mjs";
import { mineAndRegisterSkills } from "./skill-miner.mjs";
import { validateRegisteredSkills } from "./skill-validator.mjs";

const reset = process.argv.includes("--reset");
const workspaceArg = process.argv.find((value) => value.startsWith("--workspace="));
const workspaceId = workspaceArg ? workspaceArg.slice("--workspace=".length).trim() : null;

const store = createTrajectoryStore();
const policy = createPolicyController({ mode: "online" });
const teamPolicy = createTeamPolicyController({ mode: "online" });
const skills = createSkillRegistry();
const trajectories = await store.list(workspaceId ? { workspaceId } : {});
const [strategy, team] = await Promise.all([
  policy.trainOffline(trajectories, { reset }),
  teamPolicy.trainOffline(trajectories, { reset }),
]);
const mined = await mineAndRegisterSkills({ trajectoryStore: store, skillRegistry: skills, workspaceId });
const validation = await validateRegisteredSkills({ trajectoryStore: store, skillRegistry: skills, workspaceId });
const stats = await store.stats(workspaceId ? { workspaceId } : {});

console.log(JSON.stringify({
  ok: true,
  reset,
  workspaceId,
  trajectories: trajectories.length,
  strategy,
  team,
  skills: {
    mined: mined.mined,
    validation,
    registry: await skills.stats(),
  },
  replay: stats,
}, null, 2));
