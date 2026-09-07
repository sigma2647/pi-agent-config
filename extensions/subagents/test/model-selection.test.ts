/**
 * Tests for DSH-inspired model-selection mechanics:
 * ref splitting, route↔effort coupling, and preflight validation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../pi-extension/subagents/index.ts";

const {
  splitModelRef,
  bareModelRef,
  resolveEffectiveThinking,
  assertModelAvailable,
  findAvailableModel,
  formatAvailableModelsDetail,
} = __test__;

describe("splitModelRef", () => {
  it("splits a plain provider/model ref", () => {
    assert.deepEqual(splitModelRef("zai-coding-cn/glm-5.3"), {
      provider: "zai-coding-cn",
      id: "glm-5.3",
      thinking: undefined,
    });
  });

  it("detaches a valid :thinking suffix on the last colon", () => {
    assert.deepEqual(splitModelRef("zai-coding-cn/glm-5.3:high"), {
      provider: "zai-coding-cn",
      id: "glm-5.3",
      thinking: "high",
    });
  });

  it("keeps non-thinking colons inside the model id", () => {
    assert.deepEqual(splitModelRef("openrouter/meta-llama/llama-3:exacto"), {
      provider: "openrouter",
      id: "meta-llama/llama-3:exacto",
      thinking: undefined,
    });
  });

  it("treats an invalid thinking word as part of the id", () => {
    assert.deepEqual(splitModelRef("p/m:ultra"), {
      provider: "p",
      id: "m:ultra",
      thinking: undefined,
    });
  });
});

describe("bareModelRef", () => {
  it("strips a thinking suffix", () => {
    assert.equal(bareModelRef("zai-coding-cn/glm-5.3:high"), "zai-coding-cn/glm-5.3");
  });

  it("preserves a colon-bearing model id", () => {
    assert.equal(
      bareModelRef("openrouter/meta-llama/llama-3:exacto"),
      "openrouter/meta-llama/llama-3:exacto",
    );
  });

  it("is a no-op without a suffix", () => {
    assert.equal(bareModelRef("deepseek/deepseek-v4-pro"), "deepseek/deepseek-v4-pro");
  });
});

describe("resolveEffectiveThinking", () => {
  it("an explicit :thinking on the effective ref wins over the frontmatter", () => {
    assert.equal(
      resolveEffectiveThinking("p/m2:low", { model: "p/m1", thinking: "high" }, {}),
      "low",
    );
  });

  it("keeps the declared effort when the route is unchanged", () => {
    assert.equal(resolveEffectiveThinking("p/m1", { model: "p/m1", thinking: "high" }, {}), "high");
    // The explicit param is the declared route too.
    assert.equal(
      resolveEffectiveThinking("p/m1", { model: "p/m0", thinking: "high" }, { model: "p/m1" }),
      "high",
    );
  });

  it("clears the inherited effort when the route moved off the declared model", () => {
    // A model-pool / parent-session fallback must not inherit the pinned
    // model's thinking level.
    assert.equal(
      resolveEffectiveThinking("p/m2", { model: "p/m1", thinking: "high" }, {}),
      undefined,
    );
  });

  it("returns undefined without an agent thinking or effective model", () => {
    assert.equal(
      resolveEffectiveThinking(undefined, { model: "p/m1", thinking: "high" }, {}),
      undefined,
    );
    assert.equal(resolveEffectiveThinking("p/m1", null, {}), undefined);
    assert.equal(resolveEffectiveThinking("p/m1", { model: "p/m1" }, {}), undefined);
  });
});

describe("findAvailableModel", () => {
  it("prefers the registry find lookup", () => {
    const ctx = {
      modelRegistry: {
        find: (p: string, id: string) =>
          p === "p" && id === "m1" ? { provider: "p", id: "m1", reasoning: true } : undefined,
        getAvailable: () => [{ provider: "p", id: "m1" }],
      },
    };
    assert.deepEqual(findAvailableModel(ctx, "p", "m1"), {
      provider: "p",
      id: "m1",
      reasoning: true,
    });
    assert.equal(findAvailableModel(ctx, "p", "nope"), undefined);
  });

  it("falls back to a getAvailable scan when find is absent", () => {
    const ctx = {
      modelRegistry: {
        getAvailable: () => [{ provider: "p", id: "m1" }, { provider: "p", id: "m2" }],
      },
    };
    assert.deepEqual(findAvailableModel(ctx, "p", "m2"), { provider: "p", id: "m2" });
  });
});

describe("assertModelAvailable", () => {
  const REGISTRY = {
    getAvailable: () => [
      { provider: "p", id: "m1", reasoning: true },
      { provider: "p", id: "m2", reasoning: false },
    ],
    find: (provider: string, id: string) =>
      [
        { provider: "p", id: "m1", reasoning: true },
        { provider: "p", id: "m2", reasoning: false },
      ].find((m) => m.provider === provider && m.id === id),
  };

  it("rejects a model missing from the registry", () => {
    assert.throws(() => assertModelAvailable("p/stale", { modelRegistry: REGISTRY }), /not available/);
  });

  it("rejects a :thinking level on a non-reasoning model", () => {
    assert.throws(
      () => assertModelAvailable("p/m2:high", { modelRegistry: REGISTRY }),
      /does not support reasoning/,
    );
  });

  it("accepts a thinking level on a reasoning-capable model", () => {
    assert.doesNotThrow(() => assertModelAvailable("p/m1:high", { modelRegistry: REGISTRY }));
  });

  it("does not block when the registry is absent or empty", () => {
    assert.doesNotThrow(() => assertModelAvailable("p/anything", {}));
    assert.doesNotThrow(() =>
      assertModelAvailable("p/anything", { modelRegistry: { getAvailable: () => [] } }),
    );
  });
});

describe("formatAvailableModelsDetail", () => {
  it("renders layered, metadata-rich lines", () => {
    const ctx = {
      modelRegistry: {
        getAvailable: () => [
          { provider: "p", id: "m1", name: "Model One", reasoning: true, contextWindow: 128000 },
          { provider: "p", id: "m2", reasoning: false },
        ],
      },
    };
    const text = formatAvailableModelsDetail(ctx);
    assert.match(text, /p\/m1 — Model One \[reasoning\] \[128k ctx\]/);
    assert.match(text, /p\/m2 \[no reasoning\]/);
  });

  it("returns an empty string for an empty registry", () => {
    assert.equal(formatAvailableModelsDetail({ modelRegistry: { getAvailable: () => [] } }), "");
  });
});
