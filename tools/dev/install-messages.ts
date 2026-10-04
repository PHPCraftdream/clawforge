// Fixed parts of install-system's own report, exported so the system-install check
// asserts the same text the installer prints. A separate module because install-system.ts
// is a script: importing it would run the install.

export const INSTALLED_MARK = "==> installed:";
export const NOT_ON_PATH_HINT = "is not on PATH";
