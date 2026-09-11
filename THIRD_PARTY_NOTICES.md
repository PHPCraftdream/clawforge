# Third-party notices

## OpenClaw

ClawForge includes an adapted Docker Compose definition based on the upstream OpenClaw
project. The upstream project is available at:

https://github.com/openclaw/openclaw

OpenClaw is distributed under the MIT License. Its license and third-party notices are
maintained by the OpenClaw project. This repository does not distribute the OpenClaw image
or its source code; users obtain the image separately from the configured container registry.

The adapted file is `tools/framework/docker-compose.yml` in source form and
`dist/docker-compose.yml` in the npm package. Changes made by ClawForge include the image-only
workflow, explicit host bind mounts, loopback-by-default port publishing, and the healthcheck.

## Recipe sources

The optional `tor-socks5` recipe in the deployment example clones its own upstream source at
build time. It is disabled by default and is not part of the `@clawforge/framework` npm
package. Review that project's license before enabling or redistributing the recipe.
