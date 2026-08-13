import { runNodesCli } from "@/cli/nodes";

void runNodesCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
