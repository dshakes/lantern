import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToList, removeFromList, loadList, renderList, clearList } from "./shared-list.ts";

const dir = () => mkdtempSync(join(tmpdir(), "sl-"));

describe("shared-list", () => {
  test("add dedupes, remove is fuzzy, render + clear", () => {
    const d = dir();
    try {
      assert.deepEqual(addToList(d, ["milk", "eggs"], "Manasa", 1), ["milk", "eggs"]);
      assert.deepEqual(addToList(d, ["Milk", "bread"], "owner", 2), ["bread"]); // milk dup dropped
      assert.equal(loadList(d).length, 3);
      assert.deepEqual(removeFromList(d, ["milk"]), ["milk"]); // fuzzy match
      assert.equal(loadList(d).length, 2);
      assert.match(renderList(loadList(d)), /our list \(2\)/);
      clearList(d);
      assert.equal(loadList(d).length, 0);
      assert.match(renderList([]), /empty/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
