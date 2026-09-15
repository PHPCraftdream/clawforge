// `./clawforge deploy user@host` — puts this repository on a server and brings the instance up.
//
// Two deliveries, not one. The framework is code and is mirrored, deletions included. The
// deployment is configuration, and only the parts that are not secret travel: the
// declaration, the desired state and the recipes. Its .env, its secret stores and its
// snapshots stay here — the server generates its own token, so a leaked local one cannot
// unlock it.
//
// rsync and ssh run on the target side (inside WSL when the tooling is on Windows), because
// that is where the SSH keys and the tools live.
//
// Prerequisites on the server are the user's responsibility, as everywhere else — this
// installs nothing and reports precisely what is missing.
//
// npm distribution: this command is monorepo-specific — it mirrors the whole checkout
// (tools/ included) to a server over rsync, which only makes sense when there is a whole
// checkout to mirror. It deliberately keeps using `monorepoRoot` (env.ts), not
// `frameworkRoot` — deploying an npm-distributed app to a server would instead mean `npm
// install` on the remote and copying only the app config, which is a separate follow-up,
// not part of this round; this command stays out of scope for that mode entirely.
//
// "Out of scope" is enforced, not merely stated: see frameworkSourceRoot below. Installed
// as a package, monorepoRoot resolves to whatever directory happens to sit two levels above
// the package, and mirroring that with --delete would put an unrelated tree on the server.

import { log, info, die } from "#src/core/log.ts";
import { monorepoRoot, isMonorepoCheckout } from "#src/core/env.ts";
import { deploymentDir, deploymentName } from "#src/runtime/deployment.ts";
import { SshTransport } from "#src/runtime/transport.ts";
import type { Context } from "#src/core/context.ts";
import type { ExecResult } from "#src/runtime/transport.ts";

/** Never leaves this machine. Local state, credentials, and every deployment directory —
 *  the deployment's own files are delivered separately and by name. */
const EXCLUDES = [
  ".env",
  ".mcp.json",
  ".git/",
  "apps/",
  "backups/",
  "data/",
  "snapshots/",
  "secrets/",
  "*.tar.gz",
  "*.tar.zst",
  "*.token",
];

/** Quotes a value for the remote shell: ssh joins its arguments into one command line, so
 *  a path with a space would otherwise arrive as two. */
function quoted(value: string): string {
  return SshTransport.quote(value);
}

/** Runs a script on the target through ssh.
 *
 *  ssh does not preserve argument boundaries: everything after the destination is joined
 *  with a single space and sent to the remote login shell as one line. A script handed over
 *  as several raw tokens — `[target, "sh", "-c", "for t in …; do …; done"]` — arrives with
 *  its own `;`, `>`, `||` unquoted, so the *outer* login shell parses them instead of the
 *  intended `sh -c` invocation ever seeing a single argument. Quoting the whole script as
 *  one value here is what makes it survive that join intact.
 *
 *  Exported so tools/checks/ssh-quoting.check.ts can prove the round trip against a real
 *  shell, standing in for sshd's own remote invocation, rather than trusting a
 *  reimplementation of POSIX quoting in the test itself. */
export function runRemote(
  ctx: Context,
  target: string,
  script: string,
  options: { stream?: boolean; allowFailure?: boolean; tty?: boolean } = {},
): Promise<ExecResult> {
  const tty = options.tty === true ? ["-t"] : [];
  return ctx.transport.exec(
    "ssh",
    [...tty, target, "sh", "-c", quoted(script)],
    { stream: options.stream, allowFailure: options.allowFailure },
  );
}

/** The tree this command mirrors, refusing rather than guessing when there is none.
 *
 *  Exported with the root as a parameter so both answers can be checked against real
 *  directories: the refusal is the whole point of the function, and a test that could only
 *  reach the branch this checkout happens to be in would prove exactly half of it. */
export async function frameworkSourceRoot(root: string = monorepoRoot): Promise<string> {
  if (!(await isMonorepoCheckout(root))) {
    die(
      "deploy mirrors a ClawForge checkout to the server with rsync, and there is no " +
        "checkout here — the framework is running from an installed package.\n" +
        "Deploying in this mode means installing @clawforge/framework on the server and " +
        "sending only this deployment's own files, which is a different command and does " +
        "not exist yet. Deploy from a checkout, or copy this deployment's directory across " +
        "and run ./clawforge bootstrap there.",
    );
  }
  return root;
}

export async function deploy(ctx: Context, args: string[]): Promise<void> {
  // Before the arguments: no set of them makes this command work in the wrong mode, and a
  // usage error would send the reader off to fix the wrong thing.
  const sourceRoot = await frameworkSourceRoot();

  let target: string | undefined;
  let remotePath = "/opt/openclaw";
  let bootstrapRemote = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      remotePath = args[index + 1] ?? die("--path needs a directory");
      index += 1;
    } else if (arg === "--no-bootstrap") {
      bootstrapRemote = false;
    } else if (arg.startsWith("-")) {
      die(`unknown argument: ${arg}`);
    } else {
      target = arg;
    }
  }

  if (target === undefined) die("usage: ./clawforge deploy user@host [--path <dir>] [--no-bootstrap]");

  const name = deploymentName();
  const remoteApp = `${remotePath}/apps/${name}`;

  for (const tool of ["ssh", "rsync"]) {
    const found = await ctx.transport.exec("sh", ["-c", `command -v ${tool}`], { allowFailure: true });
    if (found.code !== 0) die(`${tool} is required on the machine that reaches the server`);
  }

  log(`checking the connection to ${target}`);
  const reachable = await ctx.transport.exec(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, "true"],
    { allowFailure: true },
  );
  if (reachable.code !== 0) {
    die(`cannot connect to ${target} non-interactively — set up an SSH key first`);
  }

  // Node runs the tooling there, rsync carries the files; what the service itself needs is
  // the runtime's business, not this application's. Checked before anything is written.
  //
  // The loop's own last command is always `command -v` or `echo`, so the script exits 0
  // whether or not tools are missing — missing ones are reported through stdout, not the
  // exit code. A non-zero code here means the script itself failed to run at all.
  const needed = ["node", "rsync", ...ctx.runtime.requiredTools].join(" ");
  const missing = await runRemote(
    ctx,
    target,
    `for t in ${needed}; do command -v "$t" >/dev/null 2>&1 || echo "$t"; done`,
    { allowFailure: true },
  );
  if (missing.code !== 0) {
    die(`could not check dependencies on ${target} (exit ${missing.code}): ${missing.stderr.trim()}`);
  }
  const absent = missing.stdout.split("\n").filter((line) => line.trim() !== "");
  if (absent.length > 0) {
    die(`missing on ${target}: ${absent.join(", ")} — install them there, then run this again`);
  }

  log(`preparing ${remotePath} on ${target}`);
  // sudo -n: this runs without a terminal, so a password prompt would hang rather than ask.
  const prepared = await runRemote(
    ctx,
    target,
    `mkdir -p ${quoted(remotePath)} 2>/dev/null || ` +
      `{ sudo -n mkdir -p ${quoted(remotePath)} && sudo -n chown "$(id -u):$(id -g)" ${quoted(remotePath)}; }`,
    { allowFailure: true },
  );
  if (prepared.code !== 0) {
    die(
      `cannot create ${remotePath} on ${target}: it needs root and sudo asks for a password.\n` +
        `Prepare it once there:  sudo install -d -o "$USER" ${remotePath}`,
    );
  }

  const source = await ctx.paths.toTarget(sourceRoot);
  log(`syncing the framework to ${target}:${remotePath}`);
  await ctx.transport.exec(
    "rsync",
    [
      "-az",
      // Deletions are mirrored, but only within what is actually sent: excluded paths on
      // the server — its .env, its data, other deployments — are left alone.
      "--delete",
      ...EXCLUDES.flatMap((pattern) => ["--exclude", pattern]),
      `${source}/`,
      `${target}:${remotePath}/`,
    ],
    { stream: true },
  );

  // The deployment, by name and file. Anything not listed here does not travel.
  const local = await ctx.paths.toTarget(deploymentDir());
  log(`syncing the ${name} deployment (declaration, desired state, recipes)`);
  // No secrets directory: the server creates its own when keys are installed there.
  await runRemote(ctx, target, `mkdir -p ${quoted(`${remoteApp}/config`)} ${quoted(`${remoteApp}/recipes`)}`);
  await ctx.transport.exec("rsync", ["-az", `${local}/app.ts`, `${target}:${remoteApp}/`]);

  // Same exclusions as the framework sync: a recipe's own compose project can pick up a
  // .env from its own directory (docker compose reads one from its project directory
  // automatically), and nothing stops someone from dropping a real secret store under
  // config/ by mistake. Without these, --delete would also erase anything on the server
  // that happens to be excluded, since it only mirrors what it was actually sent — with
  // them, the exclusion is symmetric between what is sent and what --delete may touch.
  const deploymentExcludes = EXCLUDES.flatMap((pattern) => ["--exclude", pattern]);
  await ctx.transport.exec("rsync", [
    "-az",
    "--delete",
    ...deploymentExcludes,
    `${local}/config/`,
    `${target}:${remoteApp}/config/`,
  ]);
  await ctx.transport.exec("rsync", [
    "-az",
    "--delete",
    ...deploymentExcludes,
    `${local}/recipes/`,
    `${target}:${remoteApp}/recipes/`,
  ]);

  // rsync from a Windows-mounted filesystem loses the executable bit.
  await runRemote(ctx, target, `chmod +x ${quoted(`${remotePath}/clawforge`)}`);

  if (!bootstrapRemote) {
    log(`files synced to ${target}:${remotePath} (bootstrap skipped)`);
    info(`bring it up there with: cd ${remotePath} && ./clawforge --app ${name} bootstrap`);
    return;
  }

  log(`bootstrapping ${name} on ${target}`);
  // The deployment is named: the server's default would otherwise be a different one.
  // -t only when we have a terminal to give it.
  await runRemote(ctx, target, `cd ${quoted(remotePath)} && ./clawforge --app ${quoted(name)} bootstrap`, {
    stream: true,
    tty: process.stdout.isTTY === true,
  });

  log("deployed");
  info("the gateway listens on the remote loopback only. Open a tunnel from here:");
  info(`  ssh -N -L ${ctx.settings.gatewayPort}:127.0.0.1:${ctx.settings.gatewayPort} ${target}`);
  info(`provider keys are not copied — install them there: ./clawforge --app ${name} secrets --apply`);
}
