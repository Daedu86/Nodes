import { createPolicyController } from "./policy-controller.mjs";
import { createTeamPolicyController } from "./team-policy-controller.mjs";
import { createTrajectoryStore } from "./trajectory-store.mjs";

const reset = process.argv.includes("--reset");
const workspaceArg = process.argv.find((value) => value.startsWith("--workspace="));
const workspaceId = workspaceArg ? workspaceArg.slice("--workspace=".length).trim() : null;

const store = createTrajectoryStore();
const policy = createPolicyController({ mode: "online" });
const teamPolicy = createTeamPolicyController({ mode: "online" });
const trajectories = await store.list(workspaceId ? { workspaceId } : {});
const [strategy, team] = await Promise.all([
  policy.trainOffline(trajectories, { reset }),
  teamPolicy.trainOffline(trajectories, { reset }),
]);
const stats = await store.stats(workspaceId ? { workspaceId } : {});

console.log(JSON.stringify({
  ok: true,
  reset,
  workspaceId,
  trajectories: trajectories.length,
  strategy,
  team,
  replay: stats,
}, null, 2));
