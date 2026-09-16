// Sets command group: the immutable, content-addressed artifact a deployment installs
// from. Split out of index.ts, which merges every group's fragment into one
// openclawCommands.

import type { AppCommand } from "#src/core/app.ts";

import { set } from "#src/commands/sets/set.ts";

export const setsCommands: Record<string, AppCommand> = {
  set: {
    summary: "Build or validate the set: everything a deployment installs, one artifact, one content id",
    run: set,
    readOnlyWhen: (args) => ["build", "diff", "receipts", "validate"].includes(args[0] ?? ""),
    details:
      "Collects every recipe (served content and agent bundle, each file checksummed), " +
      "config/desired-state.json, the required framework version and image digest, and the " +
      "NAMES of the secrets the set needs — into sets/<name>-<id>.tar.gz inside the " +
      "deployment directory. The id is over the manifest, not the archive bytes: two builds " +
      "of an unchanged tree give the same id, so it can be compared, committed and " +
      "installed against.\n" +
      "Built without a running instance — a set is content, the thing an instance is " +
      "installed FROM. Secret values cannot enter: the manifest has no field for them, and " +
      "the build refuses to write if a value from the deployment's .env or secret stores " +
      "appears anywhere in it.\n" +
      "validate checks a whole set with no running instance — recipe completeness, agent/MCP " +
      "references, cron field shape, secret-name coverage, image pinning.\n" +
      "diff <A> <B> compares verified artifacts semantically; --from and --to provide the same inputs over MCP.\n" +
      "receipts lists saved acceptance evidence; --set-id filters it and --receipt shows one record.\n" +
      "try --set <artifact> installs it into a throwaway instance this creates on the spot — " +
      "its own directory, data path and free port, never the real deployment's — runs " +
      "whatever acceptance the set declares, and tears the instance down afterwards unless " +
      "--keep is given. One operation: a coder gets back whether the set actually works " +
      "without touching their own instance to find out.\n" +
        "forget --kind <agent|mcp-server|cron-job> --name <name> removes an object this framework created and " +
      "stops tracking it — what ./clawforge plan proposes on its own for an orphaned MCP server or " +
      "cron job, and what a coder runs by hand for an orphaned agent, since deleting one also " +
      "prunes its workspace and memory.",
    arguments: [
      { name: "action", description: "What to do with sets", kind: "positional", choices: ["build", "validate", "diff", "receipts", "try", "forget"] },
      { name: "from", description: "With diff: original artifact", kind: "option" },
      { name: "to", description: "With diff: replacement artifact", kind: "option" },
      { name: "set-id", description: "With receipts: filter by immutable set id", kind: "option" },
      { name: "receipt", description: "With receipts: show this receipt; requires --set-id", kind: "option" },
      { name: "name", description: "Set name (default: the deployment's name); with forget, the object's name", kind: "option" },
      { name: "set", description: "Artifact to validate or try, instead of the working tree", kind: "option" },
      { name: "kind", description: "With forget: agent, mcp-server, or cron-job", kind: "option", choices: ["agent", "mcp-server", "cron-job"] },
      { name: "with-model", description: "With try: include acceptance checks that call the model", kind: "flag" },
      { name: "keep", description: "With try: leave the throwaway instance running instead of tearing it down", kind: "flag" },
      { name: "break-lock", description: "With forget: take over the instance lock held by another operation", kind: "flag" },
      { name: "json", description: "Emit the manifest and its id, or the findings, as JSON", kind: "flag" },
    ],
    // Not readOnly: true for the group as a whole, even though build and validate are —
    // try brings up a real throwaway instance and forget deletes a real object, and one
    // flag on this entry cannot tell those two actions from the other two. Declaring the
    // whole command destructive is the safe direction to be wrong in: build and validate
    // ask for a confirmation they do not need, rather than try and forget skipping one they do.
    structured: true,
    destructive: true,
  },
};
