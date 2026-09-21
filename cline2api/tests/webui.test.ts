/**
 * Guards for the single-file admin UI.
 *
 * The page is one big template string, so `tsc` checks none of it. These tests
 * are the cheap safety net: the script must parse, every helper it calls must
 * be defined, and anything the DOM is expected to hand over must exist as an
 * element id. That last pair is exactly how a shipped regression looked — a
 * deleted `loadStatus()` left the boot sequence throwing a ReferenceError, so
 * the page rendered its "加载中…" placeholders forever.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_PAGE } from "../src/webui/page.js";

const script = ADMIN_PAGE.slice(
  ADMIN_PAGE.lastIndexOf("<script>") + "<script>".length,
  ADMIN_PAGE.lastIndexOf("</script>"),
);
const markup = ADMIN_PAGE.slice(0, ADMIN_PAGE.lastIndexOf("<script>"));

/** Names that are legitimately not defined in this file. */
const EXTERNALS = new Set([
  // syntax / language
  "if", "for", "while", "switch", "catch", "return", "typeof", "function", "new",
  "await", "async", "else", "do", "try", "delete", "void", "in", "of", "class",
  // browser globals used here
  "fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "confirm",
  "JSON", "String", "Number", "Boolean", "Array", "Object", "Math", "Date", "Map",
  "Set", "Promise", "Error", "RegExp", "TextDecoder", "URLSearchParams", "isNaN",
  "parseInt", "parseFloat", "isFinite", "encodeURIComponent", "decodeURIComponent", "require",
]);

test("the admin page script parses", () => {
  // `new Function` compiles the body without running it — the same check
  // `node --check` would do, but inside the test suite.
  assert.doesNotThrow(() => new Function(script));
});

/** Strip string/template literals so code embedded in text is not scanned. */
function stripStrings(source: string): string {
  return source
    .replace(/`(?:\\.|[^`\\])*`/gs, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

test("every helper the admin script calls is defined in it", () => {
  const code = stripStrings(script);
  const defined = new Set(
    [...code.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
  );
  // `const name = (…) =>` and `var name = function` styles, if ever introduced.
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function|\()/g)) {
    defined.add(m[1]);
  }
  // Callback parameters are called like helpers but are not declared with
  // `function`, so collect every parameter list too.
  for (const m of code.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
    for (const raw of (m[1] ?? "").split(",")) {
      const name = raw.trim().split(/[=\s]/)[0];
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name);
    }
  }

  const called = new Set();
  for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (EXTERNALS.has(name)) continue;
    called.add(name);
  }

  const missing = [...called].filter((name) => !defined.has(name));
  assert.deepEqual(
    missing,
    [],
    `admin script calls helpers it never defines: ${missing.join(", ")}`,
  );
});

test("every element id the admin script reaches for exists in the markup", () => {
  const declared = new Set([...markup.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  const referenced = new Set([
    ...[...script.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]),
    ...[...script.matchAll(/getElementById\("([\w-]+)"\)/g)].map((m) => m[1]),
    // ids the script builds by concatenation, e.g. "view-" + name
    ...["overview", "models", "play", "accounts", "logs"].map((v) => `view-${v}`),
  ]);
  // Created at runtime by the script itself when the token is missing.
  referenced.delete("tokenPrompt");

  const missing = [...referenced].filter((id) => !declared.has(id));
  assert.deepEqual(missing, [], `admin script references absent element ids: ${missing.join(", ")}`);
});

test("boot calls are all defined and routed through the view switcher", () => {
  // The boot sequence runs at the end of the IIFE; anything it touches must
  // exist, and every hash route must map to a real section.
  for (const view of ["overview", "models", "play", "accounts", "logs"]) {
    assert.ok(markup.includes(`id="view-${view}"`), `missing section for hash route #${view}`);
    assert.ok(markup.includes(`data-view="${view}"`), `missing nav button for #${view}`);
  }
  assert.match(script, /show\(location\.hash\.slice\(1\)\s*\|\|\s*"overview"\)/);
});
