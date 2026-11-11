// scripts/lint-desktop.mjs — static security + catalog-rule linter (Tier 5).
//
// Enforces catalog rules 8 and 17 on the desktop surface, plus the import
// allowlist and the bundle budget. The official `hermes plugins validate`
// desktop lint is regex-only over comment-stripped source with exactly four
// failing families and does NOT check magic bytes or the allowlist, so this
// script does more than the official lint (stage-0 §5):
//
//   Rule 8 (sandbox integrity): AST scan of src/ and desktop/plugin.js for
//     eval(, new Function(, dynamic import() outside the SDK/React,
//     script-tag injection, app-DOM reach ([data-slot|tour|sidebar|testid]),
//     observing document.body, and <webview> reach. A raw
//     window.hermesDesktop bridge reference is a WARNING (review cue), not
//     a violation.
//   Rule 17 (no unscannable binaries): magic-byte scan of the whole tree
//     (WASM, ELF, Mach-O, PE) plus a ban on opaque extensions
//     (.pyc/.pyo/.wasm/.so/.dylib/.dll/.exe/.zip/.tar/.gz/.7z/.whl) and
//     .DS_Store anywhere outside node_modules/ and .git/.
//   Import allowlist: desktop/plugin.js may statically import ONLY
//     @hermes/plugin-sdk, react, react/jsx-runtime. react/jsx-dev-runtime
//     is a violation.
//   Bundle budget: > 8 MiB is a violation; > 3.5 MiB is a warning.
//
// Usage: node scripts/lint-desktop.mjs   (no path argument; scans the fixed tree)
// Exit 0 only when there are 0 violations.
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "src");
const BUNDLE = join(ROOT, "desktop", "plugin.js");

const ALLOWED_IMPORTS = new Set(["@hermes/plugin-sdk", "react", "react/jsx-runtime"]);
const ALLOWED_THREE_IMPORTS = new Set([
  "three", "three/addons/loaders/GLTFLoader.js", "three/addons/controls/OrbitControls.js",
  "three/addons/controls/TransformControls.js", "three/addons/environments/RoomEnvironment.js",
  "three/addons/postprocessing/Pass.js", "three/addons/shaders/HorizontalBlurShader.js",
  "three/addons/shaders/VerticalBlurShader.js", "three/addons/utils/SkeletonUtils.js",
  // PR25: the decimate and edge split modifiers (pure JS, in three's own examples).
  "three/addons/modifiers/SimplifyModifier.js", "three/addons/modifiers/EdgeSplitModifier.js",
  // PR24: sub-object picking on the edit copy only. Pinned exactly, ships no .wasm, and is used
  // without patching any prototype (see the prototype check below).
  "three-mesh-bvh",
  // PR23: text outlines. Pinned exactly; no .wasm, no dynamic import() or eval in the bundle.
  "opentype.js",
  // PR27: the Settle physics. Pinned exactly; pure JS, no .wasm, no dynamic import() or eval.
  "three-gpu-pathtracer",
  "cannon-es",
]);
const SIZE_GATE_BYTES = 8 * 1024 * 1024;
const SIZE_TARGET_BYTES = Math.round(3.5 * 1024 * 1024);

const violations = [];
const warnings = [];

function violation(rule, file, line, detail) {
  violations.push({ rule, file, line, detail });
}
function warn(rule, file, line, detail) {
  warnings.push({ rule, file, line, detail });
}

// ---------------------------------------------------------------- AST scan
const DATA_ATTRS = ["[data-slot", "[data-tour", "[data-sidebar", "[data-testid"];

function isStringLiteral(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function checkNode(node, sourceFile, relFile) {
  const lineOf = (n) => sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line + 1;

  // eval( — bare identifier call only (x.eval( is a property call, not the global).
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") {
    violation("rule-8: eval", relFile, lineOf(node), "call to eval()");
  }

  // Prototype patching (PR24, rule 8). three-mesh-bvh documents patching
  // THREE.Mesh.prototype.raycast and BufferGeometry.prototype.computeBoundsTree. This plugin sets
  // boundsTree and raycast on the one edit-copy instance instead and never touches a shared prototype.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
    const left = node.left.getText(sourceFile);
    if (/\.prototype\.(raycast|computeBoundsTree|disposeBoundsTree|computeBoundsTreeAsync)\b/.test(left)
      || /^(THREE\.)?(Mesh|BufferGeometry|Object3D|SkinnedMesh)\.prototype\b/.test(left)) {
      violation("rule-8: prototype patching", relFile, lineOf(node), `assignment to ${left}`);
    }
  }

  // new Function(
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
    violation("rule-8: new Function", relFile, lineOf(node), "Function constructor");
  }

  // Dynamic import(): only SDK/React specifiers are allowed, and only as literals.
  // (In the TS AST a dynamic import is a CallExpression whose callee is the
  // ImportKeyword — there is no ts.isImportExpression predicate.)
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const arg = node.arguments[0];
    if (arg && isStringLiteral(arg)) {
      if (!ALLOWED_IMPORTS.has(arg.text) && !arg.text.startsWith("@hermes/plugin-sdk/") && !arg.text.startsWith("react/")) {
        violation("rule-8: dynamic import", relFile, lineOf(node), `dynamic import of ${JSON.stringify(arg.text)}`);
      }
    } else {
      violation("rule-8: dynamic import", relFile, lineOf(node), "dynamic import with non-literal specifier");
    }
  }

  // createElement('script') and <script in a string literal.
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : "";
    const first = node.arguments[0];
    if (calleeName === "createElement" && first && isStringLiteral(first) && first.text === "script") {
      violation("rule-8: script injection", relFile, lineOf(node), "createElement('script')");
    }
    if ((calleeName === "querySelector" || calleeName === "querySelectorAll" || calleeName === "closest" || calleeName === "getElementsByTagName") && first && isStringLiteral(first) && first.text.startsWith("webview")) {
      violation("rule-8: preview guest reach", relFile, lineOf(node), `${calleeName}('webview'...)`);
    }
    if ((calleeName === "querySelector" || calleeName === "querySelectorAll" || calleeName === "getElementById" || calleeName.startsWith("getElementsBy")) && first && isStringLiteral(first)) {
      if (DATA_ATTRS.some((a) => first.text.includes(a))) {
        violation("rule-8: app DOM reach", relFile, lineOf(node), `host markup selector ${JSON.stringify(first.text)}`);
      }
    }
    // .observe(document.body, ...) — MutationObserver on the host body.
    if (calleeName === "observe" && first && ts.isPropertyAccessExpression(first)
      && ts.isIdentifier(first.expression) && first.expression.text === "document" && first.name.text === "body") {
      violation("rule-8: app DOM reach", relFile, lineOf(node), "observing document.body");
    }
  }

  // <script inside a string literal (a payload; comments are not AST nodes).
  if (isStringLiteral(node) && node.text.toLowerCase().includes("<script")) {
    violation("rule-8: script injection", relFile, lineOf(node), "string literal contains <script");
  }

  // window.hermesDesktop / globalThis.hermesDesktop — review cue, warning only.
  if (ts.isPropertyAccessExpression(node) && node.name.text === "hermesDesktop"
    && ts.isIdentifier(node.expression) && ["window", "globalThis", "self"].includes(node.expression.text)) {
    warn("rule-8 review: raw bridge", relFile, lineOf(node), "window.hermesDesktop reference — use ctx.files / ctx.os / host.request");
  }

  // Static imports / re-exports (allowlist is enforced on the bundle below,
  // but flagging src/ too catches a bad import before the build).
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && isStringLiteral(node.moduleSpecifier)) {
    const spec = node.moduleSpecifier.text;
    if (!ALLOWED_IMPORTS.has(spec) && !spec.startsWith("./") && !spec.startsWith("../") && !ALLOWED_THREE_IMPORTS.has(spec)) {
      violation("import allowlist", relFile, lineOf(node), `static import of ${JSON.stringify(spec)}`);
    }
  }

  ts.forEachChild(node, (child) => checkNode(child, sourceFile, relFile));
}

function scanJsFile(absPath) {
  const relFile = relative(ROOT, absPath);
  const text = readFileSync(absPath, "utf8");
  const isTsx = absPath.endsWith(".tsx");
  const sourceFile = ts.createSourceFile(
    relFile,
    text,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.JS,
  );
  checkNode(sourceFile, sourceFile, relFile);
}

function collectJs(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      collectJs(p, out);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

const jsFiles = [];
if (statSync(SRC_DIR, { throwIfNoEntry: false })) collectJs(SRC_DIR, jsFiles);
try {
  if (statSync(BUNDLE).isFile()) jsFiles.push(BUNDLE);
} catch {
  violation("bundle", "desktop/plugin.js", 0, "bundle missing — run node scripts/build-desktop.mjs first");
}
for (const f of jsFiles) scanJsFile(f);

// Bundle import allowlist, exact: only the three specifiers may appear.
try {
  const bundleText = readFileSync(BUNDLE, "utf8");
  const bundleSf = ts.createSourceFile("desktop/plugin.js", bundleText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const seen = new Set();
  const collect = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && isStringLiteral(node.moduleSpecifier)) {
      seen.add(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && isStringLiteral(node.arguments[0])) {
      seen.add(node.arguments[0].text);
    }
    ts.forEachChild(node, collect);
  };
  collect(bundleSf);
  for (const spec of seen) {
    if (!ALLOWED_IMPORTS.has(spec)) {
      violation("import allowlist", "desktop/plugin.js", 0, `bundle imports ${JSON.stringify(spec)}`);
    }
  }
  if (bundleText.includes("react/jsx-dev-runtime")) {
    violation("import allowlist", "desktop/plugin.js", 0, "bundle references react/jsx-dev-runtime");
  }
  const size = statSync(BUNDLE).size;
  if (size > SIZE_GATE_BYTES) {
    violation("bundle budget", "desktop/plugin.js", 0, `bundle is ${(size / 1048576).toFixed(2)} MiB, over the 8 MiB gate`);
  } else if (size > SIZE_TARGET_BYTES) {
    warn("bundle budget", "desktop/plugin.js", 0, `bundle is ${(size / 1048576).toFixed(2)} MiB, above the 3.5 MiB target (not a gate)`);
  }
} catch (err) {
  if (!violations.some((v) => v.file === "desktop/plugin.js" && v.rule === "bundle")) {
    violation("bundle", "desktop/plugin.js", 0, `could not read bundle: ${err.message}`);
  }
}

// ------------------------------------------------------- magic-byte scan
const MAGIC = [
  [Buffer.from([0x00, 0x61, 0x73, 0x6d]), "WebAssembly (\\0asm)"],
  [Buffer.from([0x7f, 0x45, 0x4c, 0x46]), "ELF"],
  [Buffer.from([0xfe, 0xed, 0xfa, 0xce]), "Mach-O 32-bit"],
  [Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), "Mach-O 64-bit"],
  [Buffer.from([0xce, 0xfa, 0xed, 0xfe]), "Mach-O 32-bit (reverse)"],
  [Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), "Mach-O 64-bit (reverse)"],
  [Buffer.from([0xca, 0xfe, 0xba, 0xbe]), "Mach-O universal"],
  [Buffer.from([0x4d, 0x5a]), "PE/DOS (MZ)"],
];
const OPAQUE_EXTS = new Set([".pyc", ".pyo", ".wasm", ".so", ".dylib", ".dll", ".exe", ".zip", ".tar", ".gz", ".7z", ".whl"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv"]);

function scanTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      scanTree(p);
      continue;
    }
    const relFile = relative(ROOT, p);
    if (entry.name === ".DS_Store") {
      violation("rule-17: packaging", relFile, 0, ".DS_Store must not be committed");
      continue;
    }
    if (OPAQUE_EXTS.has(extname(entry.name).toLowerCase())) {
      violation("rule-17: opaque binary", relFile, 0, `opaque extension ${extname(entry.name)}`);
      continue;
    }
    let head;
    try {
      head = readHead(p);
    } catch {
      continue;
    }
    for (const [magic, label] of MAGIC) {
      if (head.length >= magic.length && head.subarray(0, magic.length).equals(magic)) {
        violation("rule-17: magic bytes", relFile, 0, `magic bytes match ${label}`);
        break;
      }
    }
  }
}

// Synchronous small read of the first 8 bytes.
// Rule 8, CSS (UI/UX redesign §4.1, PR32): the plugin's one stylesheet
// (src/ui/styles.ts, the P3D_CSS template) may select only its own
// `.p3d-` namespace — never host markup ([data-slot], body, html, bare
// element selectors). Every selector in every rule must START with
// `.p3d-`; @media / @supports / @container bodies are checked the same way, and
// @keyframes bodies (from/to/percent steps) are skipped.
export function cssSelectorViolations(css) {
  const out = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  const walk = (end, inKeyframes) => {
    while (i < end) {
      const open = text.indexOf("{", i);
      if (open === -1 || open >= end) { i = end; return; }
      const prelude = text.slice(i, open).trim();
      // find the matching close brace
      let depth = 1, j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      const close = j - 1;
      if (prelude.startsWith("@keyframes") || prelude.startsWith("@-webkit-keyframes")) {
        // skip the frames
      } else if (prelude.startsWith("@media") || prelude.startsWith("@supports") || prelude.startsWith("@container")) {
        i = open + 1;
        walk(close, false);
      } else if (!inKeyframes) {
        for (const sel of prelude.split(",")) {
          const s = sel.trim();
          if (!s.startsWith(".p3d-")) out.push(s);
          if (/\[data-(slot|tour|sidebar|testid)/.test(s)) out.push(s);
        }
      }
      i = close + 1;
    }
  };
  walk(text.length, false);
  return out;
}

const STYLES_FILE = join(SRC_DIR, "ui", "styles.ts");
try {
  const stylesText = readFileSync(STYLES_FILE, "utf8");
  const m = /P3D_CSS\s*=\s*String\.raw`([\s\S]*?)`;/.exec(stylesText);
  if (!m) {
    violation("rule-8: css", "src/ui/styles.ts", 0, "P3D_CSS template not found");
  } else {
    for (const bad of cssSelectorViolations(m[1])) {
      violation("rule-8: css", "src/ui/styles.ts", 0, `selector outside the .p3d- namespace: ${JSON.stringify(bad)}`);
    }
  }
} catch {
  // No stylesheet yet: nothing to check.
}

function readHead(p) {
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(8);
    const n = readSync(fd, buf, 0, 8, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

scanTree(ROOT);

// ---------------------------------------------------------------- report
for (const v of violations) {
  console.error(`VIOLATION [${v.rule}] ${v.file}${v.line ? ":" + v.line : ""} — ${v.detail}`);
}
for (const w of warnings) {
  console.warn(`WARNING [${w.rule}] ${w.file}${w.line ? ":" + w.line : ""} — ${w.detail}`);
}
console.log(`lint-desktop: ${violations.length} violation(s), ${warnings.length} warning(s)`);
if (violations.length > 0) process.exit(1);
