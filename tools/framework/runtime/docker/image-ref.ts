// Image references — one grammar, owned here as a value: [registry[:port]/]repo[:tag]
// [@sha256:<64 lowercase hex>]. A registry port's colon is always followed by a slash, never
// read as a tag. Call sites parse once and pass the value on; .env, the recreated container
// and every report get the same format() string. Also registry digest resolution and
// exit-code readback for ./clawforge upgrade.

import { UserError } from "../../core/io/log.ts";
import type { Transport } from "../transport/transport.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** A parsed image reference. `registry` is a host with an optional port. */
export interface ImageRef {
  readonly registry?: string;
  readonly repository: string;
  readonly tag?: string;
  readonly digest?: string;
}

function splitReference(value: string): ImageRef | undefined {
  if (value === "" || value.trim() !== value || /\s/.test(value)) return undefined;
  let rest = value;
  let digest: string | undefined;
  const at = value.lastIndexOf("@");
  if (at >= 0) {
    rest = value.slice(0, at);
    digest = value.slice(at + 1);
    if (!DIGEST.test(digest)) return undefined;
  }
  let registry: string | undefined;
  const slash = rest.indexOf("/");
  if (slash > 0) {
    const head = rest.slice(0, slash);
    if (head.includes(".") || head.includes(":") || head === "localhost") {
      registry = head;
      rest = rest.slice(slash + 1);
    }
  }
  let repository = rest;
  let tag: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    tag = rest.slice(colon + 1);
    repository = rest.slice(0, colon);
    if (!TAG.test(tag) || repository === "") return undefined;
  }
  if (repository === "" || repository.includes(":") || repository.includes("@")) return undefined;
  return { registry, repository, tag, digest };
}

/** Parses a reference, throwing a UserError that names the input on anything else. */
export function parse(value: string): ImageRef {
  const ref = tryParse(value);
  if (ref === undefined) {
    throw new UserError(`"${value}" is not a valid image reference — expected [registry[:port]/]repo[:tag][@sha256:<64 hex characters>]`);
  }
  return ref;
}

export function tryParse(value: string): ImageRef | undefined {
  return splitReference(value);
}

/** The canonical string form — parse(format(x)) is x again. */
export function format(ref: ImageRef): string {
  const registry = ref.registry === undefined ? "" : `${ref.registry}/`;
  const tag = ref.tag === undefined ? "" : `:${ref.tag}`;
  const digest = ref.digest === undefined ? "" : `@${ref.digest}`;
  return `${registry}${ref.repository}${tag}${digest}`;
}

/** The `repo[:tag]` a tag names, with any digest removed — the channel a plain upgrade
 *  re-resolves, independent of which content it currently points at. */
export function channel(ref: ImageRef): string {
  return format({ ...ref, digest: undefined });
}

/** The registry/repository a reference names, with any tag or digest stripped. */
export function repositoryOf(ref: ImageRef): string {
  return format({ registry: ref.registry, repository: ref.repository });
}

export function withDigest(ref: ImageRef, digest: string): ImageRef {
  return { ...ref, digest };
}

/** The sha256 digest a value carries — bare (`sha256:…`, Docker's own answer) or as part of
 *  a reference — or undefined when it names no exact content. A value that carries no
 *  well-formed digest but ends in `@sha256:…` still yields that suffix: content comparison
 *  is lexical, and a pin already recorded in a non-canonical spelling must keep comparing
 *  equal to itself. Only parse() enforces the grammar. */
export function digestOf(value: string): string | undefined {
  if (DIGEST.test(value)) return value;
  const parsed = tryParse(value);
  if (parsed !== undefined) return parsed.digest;
  const at = value.lastIndexOf("@sha256:");
  return at >= 0 ? value.slice(at + 1) : undefined;
}

/** Whether a value pins exact content — `repo[@:tag]@sha256:…` — rather than a moving tag. */
export function hasDigest(value: string): boolean {
  return value.includes("@sha256:");
}

function contentId(value: string): string {
  const digest = digestOf(value);
  if (digest !== undefined) return digest;
  const ref = tryParse(value);
  return ref === undefined ? value : format(ref);
}

/** Whether two spellings name the same content: a digest and the reference carrying it match,
 *  so do a bare Docker digest and its full form; two tag-only references match only when
 *  identical — a tag never stands for whatever it happens to resolve to right now. */
export function sameContent(a: string, b: string): boolean {
  return contentId(a) === contentId(b);
}

/** Registry digest for `reference` via `docker buildx imagetools inspect` — never pulls a
 *  layer or moves a local tag, unlike `docker pull`/`docker image inspect`. Undefined on any
 *  failure: "could not ask" must never read as "asked and got nothing". Returns the channel
 *  pinned with the resolved digest (`repo:tag@sha256:…`), so `upgrade` reads the tag back to
 *  know what to re-resolve. */
export async function resolveImageDigest(transport: Transport, reference: string): Promise<string | undefined> {
  const result = await transport.exec("docker", ["buildx", "imagetools", "inspect", reference], { allowFailure: true });
  const digest = result.code === 0 ? /^Digest:\s+(\S+)/m.exec(result.stdout)?.[1] : undefined;
  if (digest === undefined) return undefined;
  const ref = tryParse(reference);
  return `${ref === undefined ? reference.split("@")[0] : channel(ref)}@${digest}`;
}

/** The container's own exit code, or undefined when there is no container or the inspect
 *  failed — how a migration failure (upstream docs: exit code 78) is told apart from one
 *  still starting up. */
export async function lastExitCode(transport: Transport, containerId: string | undefined): Promise<number | undefined> {
  if (containerId === undefined) return undefined;
  const result = await transport.exec("docker", ["inspect", "--format", "{{.State.ExitCode}}", containerId], { allowFailure: true });
  return result.code === 0 ? Number.parseInt(result.stdout.trim(), 10) : undefined;
}
