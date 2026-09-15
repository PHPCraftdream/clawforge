# Changelog

All notable changes to `@clawforge/framework` will be documented here.

## Unreleased

Nothing released yet — 0.1.0 below is what the first tag will carry.

## 0.1.0

The initial development release, under the dual MIT or Apache-2.0 license. It provides
transport-aware lifecycle commands, reproducible set artifacts, archive verification, and
project-local MCP configuration for Claude Code and Codex. SSH deployment and model-backed
acceptance remain explicitly experimental.

Known limitations of this release:

* The SSH transport and the native local (non-WSL) transport are covered by checks but have
  not been exercised against a live server.
* `set try` supports local Linux and Windows-to-WSL targets only; over SSH it refuses.
