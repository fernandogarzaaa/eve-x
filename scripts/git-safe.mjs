// Shared git-execution hygiene for release scripts: git honors GIT_DIR and
// friends from the environment, which would let a crafted env redirect
// revision queries at a different repository (forged HEAD baked into
// release identity). Every release script must scrub these before shelling
// out. verify-release.mjs asserts this file is used (honesty gate: no raw
// `git rev-parse` execSync without gitEnv in scripts/).
export function gitEnv(base = process.env) {
  const env = { ...base };
  for (const k of [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_PREFIX", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete env[k];
  }
  return env;
}
