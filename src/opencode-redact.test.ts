import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactSecrets } from "./opencode.js";

describe("redactSecrets", () => {
  it("redacts apiKey and nested secrets", () => {
    const out = redactSecrets({
      id: "opencode",
      settings: { apiKey: "secret-value", baseURL: "https://example" },
      nested: { token: "abc", ok: 1 },
    }) as Record<string, unknown>;
    const settings = out.settings as Record<string, unknown>;
    assert.equal(settings.apiKey, "[redacted]");
    assert.equal(settings.baseURL, "https://example");
    const nested = out.nested as Record<string, unknown>;
    assert.equal(nested.token, "[redacted]");
    assert.equal(nested.ok, 1);
  });
});
