// Ensure base analysis does not realpath scratch bind paths before copy; the fixture fails
// such resolutions until its copy handler creates the actual source directory.
import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { ref, trialFixture, useRecipesRoot } from "../../fixture.ts";

const root = await useRecipesRoot("clawwright-recipe-trial-copy-order");
try {
  await root.write("subject", { description: "A copied-data bind", privatePaths: ["state"] });
  const fixture = trialFixture();
  fixture.failMissingScratchBind = true;
  const timeline: string[] = [];
  const inner = fixture.ctx.transport.exec.bind(fixture.ctx.transport);
  (fixture.ctx.transport as { exec: typeof inner }).exec = async (command: string, args: string[], options?: unknown) => {
    if (command === "sh" && args[2] === "recipe-docker" && args.slice(3).includes("config")) {
      const files = args.filter((arg) => arg === "--file").length;
      if (files === 1 && fixture.baseConfigJson === null) {
        const home = fixture.mkdirPrivateCalls[0] ?? "";
        fixture.baseConfigJson = JSON.stringify({ services: { app: {
          image: "nginx",
          ports: [{ mode: "ingress", host_ip: "", target: 8080, published: "8080", protocol: "tcp" }],
          volumes: [{ type: "bind", source: `${home}/data/state`, target: "/state" }],
        } } });
      }
      timeline.push(files > 1 ? "config-merged" : "config-base");
    }
    if (command === "sh" && args[0] === "-c" && args[2] === "recipe-trial-copy") {
      timeline.push("copy");
      const home = args[3] ?? "";
      fixture.dirs.add(`${home}/data/state`);
    }
    if (command === "sh" && args[0] === "-c" && args[2] === "recipe-trial-mount-realpath") timeline.push("mount-realpath");
    return inner(command, args, options as never);
  };
  const outcome = await (async () => {
    try { await runTrialAction(fixture.ctx, ref("subject")); return ""; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })();
  check("copied-data bind run succeeds", outcome, "");
  checkTrue("copy precedes merged config", timeline.indexOf("copy") >= 0 && timeline.indexOf("copy") < timeline.indexOf("config-merged"));
  checkTrue("base analysis performs no scratch realpath", timeline.filter((item) => item === "mount-realpath").length === 1);
  checkTrue("merged mount realpath follows copy and merged config", timeline.indexOf("copy") < timeline.lastIndexOf("mount-realpath")
    && timeline.indexOf("config-merged") < timeline.lastIndexOf("mount-realpath"));
} finally {
  await root.dispose();
}
finish("recipe-trial-round4-copy-before-proof");
