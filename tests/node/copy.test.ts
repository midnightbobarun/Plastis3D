// tests/node/copy.test.ts — gateway error-code to toast mapping (Tier 2, PR5).
//
// Covers src/copy.ts toastForCode: REVISION_CONFLICT drag vs edit,
// EXPORT_FAILED reason tokens (including an unknown token falling back
// to exportGeneric), the rejected sentence (server message appended,
// else the code), and the warning/info kinds.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { COPY, toastForCode } from "../../src/copy";

describe("toastForCode", () => {
  it("REVISION_CONFLICT uses the drag sentence for drags, the edit sentence otherwise", () => {
    expect(toastForCode("REVISION_CONFLICT", { context: "drag" }).id).toBe(
      "conflictDrag",
    );
    expect(toastForCode("REVISION_CONFLICT", { context: "edit" }).id).toBe(
      "conflictEdit",
    );
    expect(toastForCode("REVISION_CONFLICT").id).toBe("conflictEdit");
    expect(toastForCode("REVISION_CONFLICT", { context: "drag" }).message).toBe(
      COPY.conflictDrag,
    );
    expect(toastForCode("REVISION_CONFLICT", { context: "edit" }).message).toBe(
      COPY.conflictEdit,
    );
  });

  it("maps the EXPORT_FAILED reason tokens", () => {
    const cases: Array<[string, string]> = [
      ["sparse", "exportSparse"],
      ["mode", "exportMode"],
      ["morph", "exportMorph"],
      ["skin", "exportSkin"],
      ["animation", "exportAnim"],
      ["extension", "exportExtension"],
      ["index", "exportIndex"],
      ["scene", "exportScene"],
    ];
    for (const [reason, id] of cases) {
      expect(toastForCode("EXPORT_FAILED", { reason }).id).toBe(id);
      expect(toastForCode("EXPORT_FAILED", { reason }).message).toBe(
        COPY[id as keyof typeof COPY],
      );
    }
  });

  it("an unknown EXPORT_FAILED reason falls back to exportGeneric", () => {
    expect(toastForCode("EXPORT_FAILED", { reason: "bogus" }).id).toBe(
      "exportGeneric",
    );
    expect(toastForCode("EXPORT_FAILED").id).toBe("exportGeneric");
    expect(toastForCode("EXPORT_FAILED", { reason: "bogus" }).message).toBe(
      COPY.exportGeneric,
    );
  });

  it("rejected appends the server message, else the code", () => {
    const withMessage = toastForCode("SOMETHING_NEW", {
      serverMessage: "the gateway said no",
    });
    expect(withMessage.id).toBe("rejected");
    expect(withMessage.message).toBe(`${COPY.rejected} the gateway said no`);
    const withoutMessage = toastForCode("SOMETHING_NEW");
    expect(withoutMessage.message).toBe(`${COPY.rejected} SOMETHING_NEW`);
  });

  it("an unknown LIMIT_* code is rejected, not a limit toast", () => {
    expect(toastForCode("LIMIT_FOO").id).toBe("rejected");
    expect(toastForCode("LIMIT_NODES").id).toBe("limitNodes");
    expect(toastForCode("LIMIT_MATERIALS").id).toBe("limitMaterials");
    expect(toastForCode("LIMIT_ASSETS").id).toBe("limitAssets");
    expect(toastForCode("LIMIT_SCENE").id).toBe("limitScene");
  });

  it("warning kinds are the conflict/busy/locked toasts; the rest are info", () => {
    expect(toastForCode("REVISION_CONFLICT", { context: "drag" }).kind).toBe(
      "warning",
    );
    expect(toastForCode("REVISION_CONFLICT", { context: "edit" }).kind).toBe(
      "warning",
    );
    expect(toastForCode("STORE_BUSY").kind).toBe("warning");
    expect(toastForCode("NODE_LOCKED").kind).toBe("warning");
    expect(toastForCode("EXPORT_FAILED", { reason: "skin" }).kind).toBe("info");
    expect(toastForCode("SCENE_NOT_FOUND").kind).toBe("info");
    expect(toastForCode("SOMETHING_NEW").kind).toBe("info");
  });

  it("maps the remaining known codes", () => {
    expect(toastForCode("STORE_BUSY").id).toBe("busy");
    expect(toastForCode("PATH_NOT_ON_BACKEND").id).toBe("pathRemote");
    expect(toastForCode("IMPORT_PATH_DENIED").id).toBe("pathDenied");
    expect(toastForCode("IMPORT_COMPRESSED").id).toBe("compressed");
    expect(toastForCode("IMPORT_EXTERNAL_BUFFER").id).toBe("externalBuffer");
    expect(toastForCode("IMPORT_FORMAT").id).toBe("importFormat");
    expect(toastForCode("IMPORT_NOT_FOUND").id).toBe("importNotFound");
    expect(toastForCode("IMPORT_TOO_LARGE").id).toBe("importTooLarge");
    expect(toastForCode("EXPORT_EMPTY").id).toBe("exportEmpty");
    expect(toastForCode("EXPORT_IMPORT_UNMERGED").id).toBe("exportGeneric");
    expect(toastForCode("HISTORY_EMPTY").id).toBe("historyEmpty");
    expect(toastForCode("SCENE_NOT_FOUND").id).toBe("cardBadId");
    expect(toastForCode("SCHEMA_NEWER").id).toBe("newerSchema");
    expect(toastForCode("SCHEMA_NEWER").message).toBe(COPY.newerSchema);
    expect(toastForCode("SCHEMA_NEWER").kind).toBe("info");
    expect(toastForCode("SCENE_EXISTS").id).toBe("sceneExists");
    expect(toastForCode("NODE_NOT_FOUND").id).toBe("nodeMissing");
    expect(toastForCode("NODE_LOCKED").id).toBe("nodeLocked");
    expect(toastForCode("MATERIAL_NOT_FOUND").id).toBe("materialMissing");
  });
});

describe("noSceneBody (E-02)", () => {
  it("equals the UI doc's exact string, snowman clause included", () => {
    expect(COPY.noSceneBody).toBe(
      "Try a sample, build from simple shapes, or bring in a model file (GLB, glTF, OBJ, STL or PLY). You can also ask Hermes to build a scene for you.",
    );
  });
});

describe("storeBody / readmeSwitches (G-19, N-06)", () => {
  const FALLBACK =
    "Turn on plastis3d under Capabilities → Plugins. A fresh install leaves it off.";

  it("both equal the UI doc's prescribed fallback sentence, with no column clause", () => {
    expect(COPY.storeBody).toBe(FALLBACK);
    expect(COPY.readmeSwitches).toContain("both Desktop and Agent");
    expect(COPY.storeBody).not.toContain("column");
    expect(COPY.readmeSwitches).not.toContain("column");
    expect(COPY.storeBody).not.toContain("Agent switch");
  });

  it("README.md contains the exact COPY.readmeSwitches string", () => {
    const readme = readFileSync(
      new URL("../../README.md", import.meta.url),
      "utf-8",
    );
    expect(readme).toContain(COPY.readmeSwitches);
  });
});

it("README contains the disclosure shipped in the plugin manifest", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf-8");
  const manifest = readFileSync(new URL("../../plugin.yaml", import.meta.url), "utf-8");
  const disclosure = manifest.match(/^  (Disclosure — .+)$/m)?.[1];
  expect(disclosure).toBeTruthy();
  expect(readme).toContain(disclosure);
});
