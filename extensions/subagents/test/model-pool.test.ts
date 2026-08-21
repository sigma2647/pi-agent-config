/**
 * Tests for the subagent model pool:
 * config parsing, chain building, cooldown skipping, and head resolution.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __test__ } from "../pi-extension/subagents/index.ts";

const {
  parseModelPoolLines,
  readConfiguredModelPool,
  buildModelChain,
  resolveEffectiveModelWithPool,
  isModelCooling,
  markModelFailed,
  clearModelCooldowns,
  bareModelRef,
} = __test__;

const REGISTRY = {
  modelRegistry: {
    getAvailable: () => [
      { provider: "zai-coding-cn", id: "glm-5.3" },
      { provider: "zai-coding-cn", id: "glm-5.2" },
      { provider: "deepseek", id: "deepseek-v4-pro" },
      { provider: "deepseek", id: "deepseek-v4-flash" },
    ],
  },
};

const SESSION = { model: { provider: "zai-coding-cn", id: "glm-5.3" }, ...REGISTRY };
const NO_POOL_CTX = { ...SESSION }; // used with env unset

let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "model-pool-test-"));
  for (const key of ["PI_SUBAGENT_MODEL_POOL", "PI_SUBAGENT_MODEL_COOLDOWN_MS", "PI_CODING_AGENT_DIR"]) {
    savedEnv[key] = process.env[key];
  }
  clearModelCooldowns();
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) setEnv(key, value);
  clearModelCooldowns();
});

describe("parseModelPoolLines", () => {
  it("parses refs in order, skipping comments, blanks, and malformed lines", () => {
    const text = [
      "# priority order",
      "zai-coding-cn/glm-5.3",
      "",
      "not-a-ref",
      "deepseek/deepseek-v4-pro  # inline comment",
      "zai-coding-cn/glm-5.3", // duplicate
      "slashless/",
    ].join("\n");
    assert.deepEqual(parseModelPoolLines(text), [
      "zai-coding-cn/glm-5.3",
      "deepseek/deepseek-v4-pro",
    ]);
  });
});

describe("readConfiguredModelPool", () => {
  it("env var wins over the config file and accepts comma or newline lists", () => {
    setEnv("PI_CODING_AGENT_DIR", tmpDir);
    writeFileSync(join(tmpDir, "subagent-models.txt"), "deepseek/deepseek-v4-pro\n");
    setEnv("PI_SUBAGENT_MODEL_POOL", "zai-coding-cn/glm-5.3, zai-coding-cn/glm-5.2");
    assert.deepEqual(readConfiguredModelPool(), ["zai-coding-cn/glm-5.3", "zai-coding-cn/glm-5.2"]);
    setEnv("PI_SUBAGENT_MODEL_POOL", "a/b\nc/d");
    assert.deepEqual(readConfiguredModelPool(), ["a/b", "c/d"]);
    setEnv("PI_SUBAGENT_MODEL_POOL", undefined);
    assert.deepEqual(readConfiguredModelPool(), ["deepseek/deepseek-v4-pro"]);
  });

  it("returns [] when neither env nor file exists", () => {
    setEnv("PI_SUBAGENT_MODEL_POOL", undefined);
    setEnv("PI_CODING_AGENT_DIR", join(tmpDir, "missing"));
    assert.deepEqual(readConfiguredModelPool(), []);
  });
});

describe("buildModelChain", () => {
  it("orders param → agent → pool → session and dedupes on bare refs", () => {
    setEnv("PI_SUBAGENT_MODEL_POOL", undefined);
    setEnv("PI_CODING_AGENT_DIR", tmpDir);
    writeFileSync(
      join(tmpDir, "subagent-models.txt"),
      "zai-coding-cn/glm-5.3\nzai-coding-cn/glm-5.2\ndeepseek/deepseek-v4-pro\ndeepseek/deepseek-v4-flash\n",
    );
    const chain = buildModelChain({}, null, SESSION);
    assert.deepEqual(chain, [
      "zai-coding-cn/glm-5.3", // pool head replaces session inheritance
      "zai-coding-cn/glm-5.2",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
    ]);
  });

  it("explicit param comes first; agent frontmatter second; dedupes repeats", () => {
    const chain = buildModelChain(
      { model: "deepseek/deepseek-v4-flash" },
      { model: "zai-coding-cn/glm-5.3" } as any,
      SESSION,
    );
    assert.deepEqual(chain[0], "deepseek/deepseek-v4-flash");
    assert.deepEqual(chain[1], "zai-coding-cn/glm-5.3");
    assert.equal(new Set(chain.map(bareModelRef)).size, chain.length);
  });

  it("skips pool entries not present in the registry", () => {
    const chain = buildModelChain({}, null, SESSION);
    assert.ok(chain.every((m) => !m.startsWith("anthropic/")));
  });

  it("without a pool, falls back to the session model (legacy behavior)", () => {
    setEnv("PI_CODING_AGENT_DIR", join(tmpDir, "missing"));
    const chain = buildModelChain({}, null, NO_POOL_CTX);
    assert.deepEqual(chain, ["zai-coding-cn/glm-5.3"]);
  });

  it("claude CLI children get no pool or session model", () => {
    const chain = buildModelChain({}, { cli: "claude" } as any, SESSION);
    assert.deepEqual(chain, []);
  });
});

describe("cooldown", () => {
  it("a failed model cools down and expires", () => {
    setEnv("PI_SUBAGENT_MODEL_COOLDOWN_MS", "50");
    clearModelCooldowns();
    assert.equal(isModelCooling("zai-coding-cn/glm-5.3"), false);
    markModelFailed("zai-coding-cn/glm-5.3");
    assert.equal(isModelCooling("zai-coding-cn/glm-5.3"), true);
    // thinking-suffixed ref shares the cooldown key
    assert.equal(isModelCooling("zai-coding-cn/glm-5.3:high"), true);
    return new Promise((resolve) =>
      setTimeout(() => {
        assert.equal(isModelCooling("zai-coding-cn/glm-5.3"), false);
        resolve(null);
      }, 60),
    );
  });
});

describe("resolveEffectiveModelWithPool", () => {
  it("prefers the first healthy pool entry; cooling head is skipped", () => {
    setEnv("PI_CODING_AGENT_DIR", tmpDir);
    writeFileSync(
      join(tmpDir, "subagent-models.txt"),
      "zai-coding-cn/glm-5.3\nzai-coding-cn/glm-5.2\n",
    );
    setEnv("PI_SUBAGENT_MODEL_COOLDOWN_MS", "600000");
    clearModelCooldowns();
    const first = resolveEffectiveModelWithPool({}, null, SESSION);
    assert.equal(first.model, "zai-coding-cn/glm-5.3");
    assert.equal(first.source, "pool");

    markModelFailed("zai-coding-cn/glm-5.3");
    const second = resolveEffectiveModelWithPool({}, null, SESSION);
    assert.equal(second.model, "zai-coding-cn/glm-5.2");
    assert.equal(second.chain[0], "zai-coding-cn/glm-5.3"); // chain order unchanged
  });

  it("explicit param model wins over pool and keeps its priority", () => {
    const resolved = resolveEffectiveModelWithPool(
      { model: "deepseek/deepseek-v4-pro" },
      null,
      SESSION,
    );
    assert.equal(resolved.model, "deepseek/deepseek-v4-pro");
    assert.equal(resolved.source, "param");
    assert.equal(resolved.chain[0], "deepseek/deepseek-v4-pro");
  });

  it("rejects an unavailable explicit model (fail fast)", () => {
    assert.throws(() =>
      resolveEffectiveModelWithPool({ model: "anthropic/claude-opus-99" }, null, SESSION),
    );
  });

  it("empty registry does not block resolution", () => {
    const resolved = resolveEffectiveModelWithPool(
      { model: "zai-coding-cn/glm-5.2" },
      null,
      { modelRegistry: { getAvailable: () => [] } },
    );
    assert.equal(resolved.model, "zai-coding-cn/glm-5.2");
  });
});
