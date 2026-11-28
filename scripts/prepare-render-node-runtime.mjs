import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(process.cwd());
if (!existsSync(join(root, "package-lock.json")) || !existsSync(join(root, "package.json"))) {
  throw new Error("Runtime cleanup must run from the MailPilot repository root.");
}

function removeRepositoryPath(path) {
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error("Runtime cleanup target escaped the repository root.");
  }
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}

function removeWebTestFiles(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "fixtures"].includes(entry.name)) {
        removeRepositoryPath(relative(root, path));
      } else {
        removeWebTestFiles(path);
      }
    } else if (/\.(test|spec)\.[^.]+$/.test(entry.name)) {
      removeRepositoryPath(relative(root, path));
    }
  }
}

for (const path of [
  ".github",
  "docs",
  "eval",
  "scripts",
  "apps/ai",
  "apps/api/tests",
  "packages/shared/tests"
]) {
  removeRepositoryPath(path);
}
removeWebTestFiles(join(root, "apps", "web", "src"));

console.log("Removed development-only test, evaluation, and documentation files from the Node runtime image.");
