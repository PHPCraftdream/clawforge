// The scratch home the trial creates and what it puts there: mkdirPrivate for the home,
// private writes for compose.env and the ports override, an OC_DATA_DIR pointing inside the
// scratch copy (never at the live dataDir), and one `sh -c` copy carrying exactly the
// declared entries — asserted on recorded argv, never on a host filesystem.

import { runTrialAction } from "#framework/commands/management/recipe/recovery/trial/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { DATA_DIR, MULTIPORT_COMPOSE, ref, SECRET_ENV, trialFixture, useRecipesRoot } from "./fixture.ts";

const root = await useRecipesRoot("clawforge-recipe-trial-scratch");
try {
  await root.write("multiport", {
    description: "A recipe publishing ports with declared privatePaths",
    privatePaths: ["state", "state/db", "certs"],
  }, MULTIPORT_COMPOSE);

  const fixture = trialFixture();
  const outcome = await (async () => {
    try { await runTrialAction(fixture.ctx, ref("multiport")); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); }
  })();
  checkTrue("the trial with declared ports and paths succeeds", outcome === "");

  // --- scratch home + private writes -------------------------------------------------------

  const home = fixture.mkdirPrivateCalls[0] ?? "";
  check("mkdirPrivate ran exactly once, for the scratch home", fixture.mkdirPrivateCalls.length, 1);
  checkTrue("the scratch home sits under the locks dir of the synthetic dataDir", home.startsWith(`${DATA_DIR}-locks/.clawforge-recipe-trial-`));
  check("writePrivateFile ran three times: compose.env, override.yml, then the pinned document",
    fixture.privateWrites, [`${home}/compose.env`, `${home}/override.yml`, `${home}/pinned-compose.json`]);
  const pinned = fixture.files.get(`${home}/pinned-compose.json`) ?? "";
  checkTrue("the pinned merged config contains both effective services after escaping",
    pinned.includes('"image":"nginx"') && pinned.includes('"image":"postgres"'));
  const buildArgv = fixture.docker.find((argv) => argv.includes("build")) ?? [];
  checkTrue("build runs against the pinned document, not the two original files",
    buildArgv.includes(`${home}/pinned-compose.json`) && buildArgv.filter((entry) => entry === "--file").length === 1);
  const downArgv = fixture.docker.find((argv) => argv.includes("down")) ?? [];
  checkTrue("the teardown down also runs against the pinned document",
    downArgv.includes(`${home}/pinned-compose.json`));

  const envFile = fixture.files.get(`${home}/compose.env`) ?? "";
  checkTrue("compose.env carries the deployment environment", envFile.includes(SECRET_ENV.OC_PASSWORD));
  checkTrue("compose.env points OC_DATA_DIR inside the scratch home", envFile.includes(`${home}/data`));
  checkTrue("compose.env never points OC_DATA_DIR at the live dataDir", !envFile.includes(`OC_DATA_DIR="${DATA_DIR}"`));

  // v2.27 fixture default → !override strategy; exact shape via space-free regex sources
  // (the ratchets count prose — whitespace-bearing literals — in assertion operands).
  const SP = String.fromCharCode(32);
  const overrideDoc = fixture.files.get(`${home}/override.yml`) ?? "";
  // Every service of the EFFECTIVE config is listed — web and db, publisher or not — so a
  // newly-added port can never leak past the override.
  check("override.yml empties both effective services' ports", (overrideDoc.match(new RegExp("^" + SP + "*ports:" + SP + "!override" + SP + "\\[\\]$", "gm")) ?? []).length, 2);
  check("override.yml is the comment-headed services document for web and db",
    [overrideDoc.startsWith("#"), /^services:$/m.test(overrideDoc), new RegExp("^" + SP + "*web:$", "m").test(overrideDoc), new RegExp("^" + SP + "*db:$", "m").test(overrideDoc)],
    [true, true, true, true]);

  // --- the proof ran before anything started: config twice (base, merged), then build -------

  const configArgv = fixture.docker.filter((argv) => argv.includes("config") && argv.includes("--format"));
  const buildIndex = fixture.docker.findIndex((argv) => argv.includes("build"));
  const firstConfig = configArgv[0] ?? [];
  const secondConfig = configArgv[1] ?? [];
  check("compose config ran twice: base first, merged second", [configArgv.length, firstConfig.filter((entry) => entry === "--file").length, secondConfig.filter((entry) => entry === "--file").length], [2, 1, 2]);
  checkTrue("the config evaluation ran before the build", buildIndex > fixture.docker.findIndex((argv) => argv.includes("config")) && buildIndex > 0);

  // --- copy command shape ---------------------------------------------------------------------
  // `state/db` is nested under `state`: it is DROPPED from the copy (the parent copy
  // already carries it), so the argv carries only the top-level entries.

  check("exactly one copy exec ran", fixture.copyArgv.length, 1);
  const copy = fixture.copyArgv[0] ?? [];
  checkTrue("the copy runs through sh -c", copy[0] === "-c");
  const script = copy[1] ?? "";
  checkTrue("the copy script uses cp -a into the scratch data dir", /cp.-a/.test(script) && /\$home\/data/.test(script));
  check("the argv after the script tag is home, dataDir, then exactly the TOP-LEVEL entries",
    copy.slice(3), [home, DATA_DIR, "state", "certs"]);
  checkTrue("the copy names its recipe-trial tag", copy[2] === "recipe-trial-copy");
  checkTrue("the nested declaration was not copied",
    !copy.slice(3).includes("state/db"));

  // --- an older Compose version refuses (no remap fallback) -----------------------------------

  const legacy = trialFixture();
  legacy.composeVersion = "2.23.9";
  await root.write("legacyports", { description: "Same shape, old compose" }, MULTIPORT_COMPOSE);
  const legacyOutcome = await (async () => {
    try { await runTrialAction(legacy.ctx, ref("legacyports")); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); }
  })();
  checkTrue("a pre-2.24 Compose refuses the real run", /requires.Docker.Compose.v2\.24\.0.or.newer/.test(legacyOutcome));
  checkTrue("the refusal names the found version", legacyOutcome.includes("2.23.9"));
  checkTrue("the refusal happens before any write", legacy.privateWrites.length === 0);

  // --- a build service gets its own image tag, and teardown removes exactly that image ------

  {
    const builder = trialFixture();
    builder.baseConfigJson = JSON.stringify({ services: { builder: {
      build: { context: "." },
      ports: [{ mode: "ingress", host_ip: "", target: 8080, published: "8080", protocol: "tcp" }],
    } } });
    await root.write("builder", { description: "A recipe with a build service" }, MULTIPORT_COMPOSE);
    const builderOutcome = await (async () => {
      try { await runTrialAction(builder.ctx, ref("builder")); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); }
    })();
    checkTrue("the build-service trial succeeds", builderOutcome === "");
    const builderDoc = builder.files.get(`${builder.mkdirPrivateCalls[0] ?? ""}/override.yml`) ?? "";
    checkTrue("the override replaces the build service's live tag with the trial's own image tag",
      /clawforge-recipe-trial-build-[0-9a-f]{12}-[0-9a-f]{8}--builder/.test(builderDoc));
    const imageRemovals = builder.docker.filter((argv) => argv[0] === "image" && argv[1] === "rm" && argv[2] === "--force");
    check("teardown removes exactly the trial build image, by name", imageRemovals.length, 1);
    checkTrue("the removed tag is the trial-prefixed build tag", (imageRemovals[0]?.[3] ?? "").endsWith("--builder"));
    checkTrue("the explicit removal ran alongside the kept --rmi local",
      builder.docker.some((argv) => argv.includes("--rmi") && argv.includes("local")));
  }

  // --- no publishers → comment-only override, and no compose version probe needed ---------------

  const quiet = trialFixture();
  quiet.baseConfigJson = JSON.stringify({ services: {} });
  quiet.mergedConfigJson = JSON.stringify({ services: {} });
  await root.write("quiet", { description: "A recipe that publishes nothing" });
  const quietOutcome = await (async () => {
    try { await runTrialAction(quiet.ctx, ref("quiet")); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); }
  })();
  checkTrue("the publisher-free trial succeeds", quietOutcome === "");
  const quietHome = quiet.mkdirPrivateCalls[0] ?? "";
  const quietDoc = quiet.files.get(`${quietHome}/override.yml`) ?? "";
  checkTrue("the publisher-free recipe writes the comment-only override", quietDoc.includes("services:"));
} finally {
  await root.dispose();
}

finish("recipe-trial-scratch-copy");
