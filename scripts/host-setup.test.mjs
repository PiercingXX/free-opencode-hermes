import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { copyAgentsSkippingNativePrimaries, copyDir } from "./host-setup.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-setup-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("copyDir merges into an existing destination directory", () => {
  withTemp((root) => {
    const src = path.join(root, "src");
    const dest = path.join(root, "dest");
    fs.mkdirSync(path.join(src, "skill-a"), { recursive: true });
    fs.writeFileSync(path.join(src, "skill-a", "SKILL.md"), "new");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "extra.txt"), "keep");

    copyDir(src, dest);

    assert.equal(fs.readFileSync(path.join(dest, "skill-a", "SKILL.md"), "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(dest, "extra.txt"), "utf8"), "keep");
  });
});

test("copyDir replaces a dangling dest symlink that shares a src name", () => {
  withTemp((root) => {
    const src = path.join(root, "src");
    const dest = path.join(root, "dest");
    const real = path.join(root, "real-target");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "ok.txt"), "from-src");
    fs.mkdirSync(src, { recursive: true });
    fs.symlinkSync(real, path.join(src, "design"));
    fs.mkdirSync(dest, { recursive: true });
    fs.symlinkSync(path.join(root, "missing-old-clone"), path.join(dest, "design"));
    assert.equal(fs.existsSync(path.join(dest, "design")), false);
    assert.ok(fs.lstatSync(path.join(dest, "design")).isSymbolicLink());

    copyDir(src, dest);

    const destLink = path.join(dest, "design");
    assert.ok(fs.lstatSync(destLink).isSymbolicLink());
    assert.equal(fs.realpathSync(destLink), fs.realpathSync(real));
    assert.equal(fs.readFileSync(path.join(destLink, "ok.txt"), "utf8"), "from-src");
  });
});

test("copyDir replaces a dangling dest symlink with a real directory", () => {
  withTemp((root) => {
    const src = path.join(root, "src");
    const dest = path.join(root, "dest");
    fs.mkdirSync(path.join(src, "design"), { recursive: true });
    fs.writeFileSync(path.join(src, "design", "SKILL.md"), "dir");
    fs.mkdirSync(dest, { recursive: true });
    fs.symlinkSync(path.join(root, "gone"), path.join(dest, "design"));

    copyDir(src, dest);

    const destDesign = path.join(dest, "design");
    assert.equal(fs.lstatSync(destDesign).isSymbolicLink(), false);
    assert.ok(fs.statSync(destDesign).isDirectory());
    assert.equal(fs.readFileSync(path.join(destDesign, "SKILL.md"), "utf8"), "dir");
  });
});

test("copyDir overwrites nested files and is idempotent", () => {
  withTemp((root) => {
    const src = path.join(root, "src");
    const dest = path.join(root, "dest");
    fs.mkdirSync(path.join(src, "nested"), { recursive: true });
    fs.writeFileSync(path.join(src, "nested", "a.txt"), "one");
    fs.mkdirSync(path.join(dest, "nested"), { recursive: true });
    fs.writeFileSync(path.join(dest, "nested", "a.txt"), "old");

    copyDir(src, dest);
    copyDir(src, dest);

    assert.equal(fs.readFileSync(path.join(dest, "nested", "a.txt"), "utf8"), "one");
  });
});

test("copyDir replaces a leftover dest directory when src is a symlink", () => {
  withTemp((root) => {
    const src = path.join(root, "src");
    const dest = path.join(root, "dest");
    const real = path.join(root, "real-target");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "ok.txt"), "from-src");
    fs.mkdirSync(src, { recursive: true });
    fs.symlinkSync(real, path.join(src, "design"));
    fs.mkdirSync(path.join(dest, "design"), { recursive: true });
    fs.writeFileSync(path.join(dest, "design", "stale.txt"), "old");

    copyDir(src, dest);

    const destDesign = path.join(dest, "design");
    assert.ok(fs.existsSync(path.join(destDesign, "ok.txt")));
    assert.equal(fs.existsSync(path.join(destDesign, "stale.txt")), false);
  });
});

test("copyDir follows a Git symlink placeholder file to the named directory", () => {
  withTemp((root) => {
    const src = path.join(root, "runtime", "skills");
    const dest = path.join(root, "dest", "skills");
    const real = path.join(root, "packs", "design", "workflow-skills");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "SKILL.md"), "from-pack");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "design"), "../../packs/design/workflow-skills\n");

    copyDir(src, dest);

    const destDesign = path.join(dest, "design");
    assert.equal(fs.lstatSync(destDesign).isSymbolicLink(), false);
    assert.ok(fs.statSync(destDesign).isDirectory());
    assert.equal(fs.readFileSync(path.join(destDesign, "SKILL.md"), "utf8"), "from-pack");
  });
});

test("copyDir of shipped skills survives a leftover dangling design symlink", () => {
  withTemp((root) => {
    const src = path.join(repoRoot, "xx-stack", "runtime", "skills");
    const dest = path.join(root, "skills");
    fs.mkdirSync(dest, { recursive: true });
    fs.symlinkSync(path.join(root, "old-clone", "workflow-skills"), path.join(dest, "design"));

    copyDir(src, dest);

    const destDesign = path.join(dest, "design");
    assert.ok(fs.lstatSync(destDesign).isSymbolicLink());
    assert.equal(fs.realpathSync(destDesign), fs.realpathSync(path.join(src, "design")));
    assert.ok(fs.existsSync(path.join(dest, "write-docs", "SKILL.md")));
  });
});

test("copyAgentsSkippingNativePrimaries does not copy build/plan/general", () => {
  withTemp((root) => {
    const src = path.join(root, "src");
    const dest = path.join(root, "dest");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "build.md"), "xx");
    fs.writeFileSync(path.join(src, "plan.md"), "xx");
    fs.writeFileSync(path.join(src, "general.md"), "xx");
    fs.writeFileSync(path.join(src, "reviewer.md"), "keep");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "build.md"), "native");

    copyAgentsSkippingNativePrimaries(src, dest);

    assert.equal(fs.existsSync(path.join(dest, "build.md")), false);
    assert.equal(fs.existsSync(path.join(dest, "plan.md")), false);
    assert.equal(fs.existsSync(path.join(dest, "general.md")), false);
    assert.equal(fs.readFileSync(path.join(dest, "reviewer.md"), "utf8"), "keep");
  });
});
