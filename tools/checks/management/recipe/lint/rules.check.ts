import { lintDockerfile } from "#framework/commands/management/recipe/recovery/checks/lint/rules.ts";
import { check, finish } from "#checks/kit/harness.ts";

const hash = "a".repeat(64);
const commit = "b".repeat(40);
const cases: [string, string, string[]][] = [
  ["remote ADD", "ADD https://example/a /a", ["remote-add-unpinned"]],
  ["http ADD", "ADD http://example/a /a", ["remote-add-unpinned"]],
  ["literal pinned", `ADD --checksum=sha256:${hash} https://example/a /a`, []],
  ["wrong algorithm", `ADD --checksum=sha512:${hash} https://example/a /a`, ["remote-add-unpinned"]],
  ["uppercase hex", `ADD --checksum=sha256:${hash.toUpperCase()} https://example/a /a`, ["remote-add-unpinned"]],
  ["short digest", "ADD --checksum=sha256:abc https://example/a /a", ["remote-add-unpinned"]],
  ["local ADD", "ADD archive.tar /a", []],
  ["ARG default", `ARG SUM=${hash}\nADD --checksum=sha256:$SUM https://example/a /a`, []],
  ["ARG braced", `ARG SUM=${hash}\nADD --checksum=sha256:\${SUM} https://example/a /a`, []],
  ["whole checksum ARG", `ARG SUM=sha256:${hash}\nADD --checksum=$SUM https://example/a /a`, []],
  ["unknown whole checksum ARG", "ARG SUM\nADD --checksum=$SUM https://example/a /a", ["remote-add-checksum-unverified"]],
  ["whole checksum ARG wrong prefix", `ARG SUM=sha512:${hash}\nADD --checksum=$SUM https://example/a /a`, ["remote-add-unpinned"]],
  ["unknown declared ARG", "ARG SUM\nADD --checksum=sha256:$SUM https://example/a /a", ["remote-add-checksum-unverified"]],
  ["undeclared ARG", "ADD --checksum=sha256:$SUM https://example/a /a", ["remote-add-unpinned"]],
  ["bad default", "ARG SUM=bad\nADD --checksum=sha256:$SUM https://example/a /a", ["remote-add-unpinned"]],
  ["global ARG not in stage", `ARG SUM=${hash}\nFROM scratch\nADD --checksum=sha256:$SUM https://example/a /a`, ["remote-add-unpinned"]],
  ["global redeclared", `ARG SUM=${hash}\nFROM scratch\nARG SUM\nADD --checksum=sha256:$SUM https://example/a /a`, []],
  ["curl shell", "RUN curl https://example/a | sh", ["curl-pipe-shell"]],
  ["wget bash", "RUN wget -qO- https://example/a | bash", ["curl-pipe-shell"]],
  ["quoted pipe", "RUN echo 'curl https://example/a | sh'", []],
  ["shell comment", "RUN echo ok # curl https://example/a | sh", []],
  ["exec shell", 'RUN ["sh", "-c", "curl https://example/a | sh"]', ["curl-pipe-shell"]],
  ["exec literal", 'RUN ["curl", "https://example/a", "|", "sh"]', []],
  ["continuation", "RUN curl https://example/a \\\n # ignored comment\n | bash", ["curl-pipe-shell"]],
  ["download execute", "RUN curl -o a https://example/a && sh a", ["download-without-verification"]],
  ["wget extract", "RUN wget -O a https://example/a && tar xf a", ["download-without-verification"]],
  ["redirection", "RUN curl https://example/a > a; ./a", ["download-without-verification"]],
  ["check sha256", "RUN curl -o a https://example/a && sha256sum --check sums && sh a", []],
  ["check shasum", "RUN wget -O a https://example/a && shasum -a 256 -c sums && tar xf a", []],
  ["wrong shasum", "RUN curl -o a https://example/a && shasum -a 1 -c sums && sh a", ["download-without-verification"]],
  ["separate RUN", "RUN curl -o a https://example/a\nRUN sh a", []],
  ["latest", "FROM alpine:latest", ["floating-base-tag"]],
  ["untagged registry port", "FROM host:5000/alpine", ["floating-base-tag"]],
  ["versioned", "FROM alpine:3.22", []],
  ["digest", `FROM alpine@sha256:${hash}`, []],
  ["numeric earlier stage", "FROM scratch AS first\nFROM scratch AS second\nFROM 1", []],
  ["scratch and stages", "FROM scratch AS base\nFROM base\nFROM 0", []],
  ["remote git", "RUN git clone https://example/repo", ["git-clone-unpinned"]],
  ["fetch floating", "RUN git fetch https://example/repo main", ["git-clone-unpinned"]],
  ["checkout SHA", `RUN git clone https://example/repo && git checkout ${commit}`, []],
  ["pinned fetch", `RUN git fetch https://example/repo ${commit}`, []],
  ["git ARG", "RUN git clone https://example/repo && git checkout $COMMIT", []],
  ["branch not pin", "RUN git clone https://example/repo && git checkout main", ["git-clone-unpinned"]],
  ["local git", "RUN git clone /src /dst", []],
  ["heredoc skipped", "RUN <<EOF\ncurl https://example/a | sh\nFROM latest\nEOF\nFROM scratch", ["unparsed-construct"]],
  ["waiver", "# recipe-check: allow curl-pipe-shell reviewed upstream\nRUN curl https://example/a | sh", ["waived"]],
  ["empty reason", "# recipe-check: allow curl-pipe-shell\nRUN curl https://example/a | sh", ["curl-pipe-shell"]],
  ["not preceding", "# recipe-check: allow curl-pipe-shell reviewed\n\nRUN curl https://example/a | sh", ["curl-pipe-shell"]],
];
for (const [name, source, expected] of cases) check(name, lintDockerfile(source, "Dockerfile").map((finding) => finding.code), expected);
check("compose ARG pin", lintDockerfile("ARG SUM\nADD --checksum=sha256:$SUM https://example/a /a", "Dockerfile", { SUM: hash }), []);
check("compose bad override", lintDockerfile(`ARG SUM=${hash}\nADD --checksum=sha256:$SUM https://example/a /a`, "Dockerfile", { SUM: "bad" }).map((f) => f.code), ["remote-add-unpinned"]);
check("compose cannot declare ARG", lintDockerfile("ADD --checksum=sha256:$SUM https://example/a /a", "Dockerfile", { SUM: hash }).map((f) => f.code), ["remote-add-unpinned"]);
const finding = lintDockerfile("# heading\nRUN echo ok\nADD https://example/a /a", "nested/Dockerfile")[0];
check("structured finding location", [finding.code, finding.severity, finding.file, finding.line], ["remote-add-unpinned", "error", "nested/Dockerfile", 3]);
const waived = lintDockerfile("# recipe-check: allow remote-add-unpinned documented exception\nADD https://example/a /a", "Dockerfile")[0];
check("waiver severity and location", [waived.code, waived.severity, waived.line], ["waived", "info", 2]);
check("waiver preserves code and reason", waived.message.split(/\s+/), ["waived", "remote-add-unpinned:", "documented", "exception"]);
finish("recipe lint rules");
