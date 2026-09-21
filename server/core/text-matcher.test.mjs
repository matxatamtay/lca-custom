import assert from "node:assert/strict";
import test from "node:test";
import { findTextMatches, planTextReplacement } from "./text-matcher.mjs";

test("single replacement rejects ambiguous exact matches", () => {
  assert.throws(
    () => planTextReplacement("same\nsame\n", "same", "changed"),
    /AMBIGUOUS_MATCH: old text matched 2 locations/
  );
  const all = planTextReplacement("same\nsame\n", "same", "changed", { replaceAll: true });
  assert.equal(all.content, "changed\nchanged\n");
  assert.equal(all.replacements, 2);
});

test("matcher tolerates CRLF versus LF without broad fuzzy matching", () => {
  const planned = planTextReplacement("one\r\ntwo\r\nthree\r\n", "one\ntwo\n", "ONE\nTWO\n");
  assert.equal(planned.strategy, "line_endings");
  assert.equal(planned.content, "ONE\nTWO\nthree\r\n");
});

test("matcher tolerates indentation-only differences when the block is unique", () => {
  const source = "function x() {\n    first();\n    second();\n}\n";
  const planned = planTextReplacement(source, "  first();\n  second();", "  changed();");
  assert.equal(planned.strategy, "indentation");
  assert.equal(planned.content, "function x() {\n    changed();\n}\n");
});

test("anchored whitespace matching still requires a unique block", () => {
  const source = "if (x) {\n  call(  one );\n  finish();\n}\n";
  const match = findTextMatches(source, "if (x) {\n call( one );\n finish();\n}");
  assert.equal(match.strategy, "anchored_block");
  assert.equal(match.occurrences, 1);
});
