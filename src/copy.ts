// src/copy.ts — user-visible sentences (Stage 5, PR5).
//
// Every toast sentence comes from docs/design/ui-design-first-draft.md
// §"Copy table" — the exact words, no paraphrase. `toastForCode` maps
// a gateway error code (plus the EXPORT_FAILED reason token) to the
// copy id, the sentence, and the toast kind, per §"Code and token
// mapping". Toasts are host.notify; kind is "warning" for conflict,
// busy, and locked, "info" for everything else that is not a thrown
// load. The stable code is never prefixed on conflict and locked,
// because those sentences are already specific. For `rejected`, the
// server message is appended when non-empty, the code only when the
// message is empty. Never toast a stack, a failed path, or a file
// snippet.

/** The copy table, verbatim from ui-design-first-draft.md. */
export const COPY = {
  healthOutput: "Prospective GLB",
  healthOutputJson: "JSON",
  healthOutputNodes: "Nodes",
  healthOutputSkins: "Skins",
  healthOutputClips: "Clips",
  healthOutputScope: "Prospective output",
  tidyExpired: "The scene changed. Preview again before applying.",
  healthSourceScope: "Stored source",
  healthSceneScope: "Scene data",
  healthSourceEvidence: "Related source findings",

  resizePrecisionData: "Resize cannot preserve 16-bit data-map precision. Use the original image or prepare a smaller 16-bit image in an image editor.",
  resizeSaving: "Saving resized image…",
  resizeReview: "Resize review",
  resizeFormat: "This image header or encoding cannot be safely resized. Choose a valid PNG or JPEG.",
  resizeSourceCap: "Resize can decode at most 8192 pixels on a side and 32 megapixels in total. Make this image smaller in an image editor first.",
  resizeDestinationCap: "The resized image must fit within 4096 pixels on a side and 16,777,216 pixels in total.",
  resizeOpaqueData: "Resize needs an opaque data map to preserve its channel values. Use the original image or make its alpha fully opaque first.",
  resizeOutputCap: "The resized PNG is too large for the upload. Choose a smaller resize size.",
  resizeLabel: "Resize uploaded image",
  resizeOriginal: "Keep original size",
  resizeLocalPick: "Choose image from this computer",
  resizeApply: "Resize and use image",
  resizeCancel: "Cancel resize",
  resizeColour: "Colour picture (sRGB)",
  resizeData: "Data map (linear values)",
  resizeHelp: "Resizing is reviewed before decoding. It keeps the aspect ratio and saves a new 8-bit PNG; your original file stays unchanged.",

  modifierAmbiguousBase: "This older modifier base has several primitives and no saved selection. Restore the original part before applying modifiers.",
  modifierMissingPrimitive: "The selected model primitive is missing. Restore its original base before applying modifiers.",
  modifierConflictingBase: "This older modifier base has conflicting primitive selections in history. Restore the original part before applying modifiers.",
  modifierAlphaUnsupported: "Decimate cannot preserve vertex alpha. Use another modifier or an opaque mesh.",
  uvRepairCap: "This mesh is over the UV repair triangle limit.",
  uvRepairRegions: "Too many occupied UV regions for local repair. Repack or unwrap explicitly.",
  uvRepairBorders: "Repair needs split island borders. Mark seams and unwrap explicitly.",
  uvRepairDegenerate: "This UV island has degenerate geometry and cannot be repaired.",
  uvRepairConvergence: "This UV island did not converge. Mark additional seams and unwrap explicitly.",
  uvRepairSingular: "This UV island has a singular map. Mark additional seams.",
  uvRepairSpace: "No space remains for local UV repair. Repack explicitly.",

  animation: "Animation",
  animationClip: "Animation clip",
  animationTime: "Animation time",
  animationKeys: "Animation keys",
  modifiersTitle: "Modifiers",
  modifiersFailed: "The modifiers could not be applied.",
  modifiersForeign: "This object has other settings (such as Text). Using Edit mesh or modifiers would end them, so modifiers are off here.",
  modAdd: "Add a modifier…",
  modAxis: "Axis",
  modThreshold: "Merge distance (m)",
  modCount: "Count",
  modOffset: "Offset",
  modLevels: "Levels",
  modIterations: "Iterations",
  modFactor: "Factor",
  modRatio: "Keep ratio",
  modAngle: "Angle (degrees)",
  modEnabled: "on",
  modUp: "Move up",
  modDown: "Move down",
  modRemove: "Remove",
  modTooLarge: "This stack would make too many triangles (over 100,000).",
  rigTitle: "Rig",
  rigBones: "Bones",
  rigAddBone: "Add bone",
  rigRemoveBone: "Remove bone",
  rigName: "Name",
  rigParent: "Parent",
  rigNoParent: "None",
  rigClips: "Clips",
  rigAddClip: "Add clip",
  rigAddKey: "Add key",
  rigRemoveKey: "Remove key",
  rigApply: "Apply",
  rigApplied: "Rigged",
  rigNeedsClips: "This shape has animation clips, which a rigged model cannot keep. Delete them first.",
  rigFailed: "The rig could not be applied.",
  rigHint: "Bones bend the shape. Apply makes it a locked model that plays its clips; open this section again to change the bones.",
  settle: "Settle",
  settleBar: "Settle shapes",
  settleHint: "Preview the selected objects falling under gravity onto the floor or other objects. Keep saves the result; Cancel restores their starting positions.",
  settleNeedsSelection: "Select a shape first, then settle it.",
  settleRunning: "Settling…",
  settleDone: "Settled. Keep the new positions?",
  settleNoRest: "Still moving after 10 seconds.",
  settleKeep: "Keep",
  settleKeepAnyway: "Keep anyway",
  settleKeepRecord: "Keep and record the fall",
  settleCancel: "Cancel",
  settleTooMany: "Settle works on up to 32 shapes at a time.",
  settleNothing: "Select a shape, part or model to settle.",
  curveTitle: "Curve",
  curveKind: "Kind",
  curveTube: "Tube",
  curveLathe: "Lathe",
  curveClosed: "Closed loop",
  curveRadius: "Tube radius (m)",
  curveRadial: "Sides",
  curveTubular: "Length segments",
  curveSegments: "Revolve segments",
  curveAngle: "Revolve angle (degrees)",
  curvePoints: "Curve points",
  curveAddPoint: "Add point",
  curveRemovePoint: "Remove point",
  curveAddHint: "Curve — a smooth tube through points you set",
  textTitle: "Text",
  textField: "Text to show",
  textSize: "Size (m)",
  textDepth: "Depth (m)",
  textLineHeight: "Line height",
  textCurve: "Curve segments",
  textAlign: "Align",
  textLeft: "Left",
  textCentre: "Centre",
  textRight: "Right",
  textBevel: "Bevel the edges",
  textApply: "Apply",
  textUnapplied: "not applied",
  textReady: "Ready",
  textMissing: "The bundled font has no glyph for:",
  textTooComplex: "This text is too detailed. Use fewer characters, a lower curve setting or no bevel.",
  textFailed: "The text could not be built.",
  textAddHint: "Text — 3D letters you can edit",
  toolMesh: "Mesh",
  toolSculpt: "Sculpt",
  toolPaint: "Paint",
  brushDraw: "Draw",
  brushSmooth: "Smooth",
  brushFlatten: "Flatten",
  brushGrab: "Grab",
  brushRadius: "Radius (px)",
  brushStrength: "Strength",
  brushHardness: "Hardness",
  brushColor: "Colour",
  brushSymmetry: "Mirror X",
  brushFill: "Fill",
  uvTitle: "UV map",
  uvUnwrap: "Unwrap",
  uvPack: "Pack",
  uvRepair: "Repair",
  uvAutoSeams: "Cut sharp edges (degrees)",
  uvAngle: "Seam angle",
  uvCanvas: "UV islands",
  uvIsland: "Island handles",
  uvNothingToRepair: "Nothing to repair.",
  uvForeign: "This object has other settings (such as Text or modifiers). Unwrapping would end them, so the UV map is off here.",
  editMarkSeam: "Mark seam",
  editSelectEdges: "Switch to Edge (2) and select some edges first.",
  editSeamNothing: "That cut does not separate anything yet. A seam needs to be a closed loop or reach an open edge.",
  editSeamMarked: "Seam marked. The edges are now cuts for unwrapping.",
  libraryTitle: "Files in this scene",
  libraryUsed: "used",
  libraryUnused: "unused",
  libraryRemoveUnused: "Remove unused",
  libraryPreview: "This removes the files this scene no longer uses:",
  libraryApply: "Remove them",
  libraryRemoved: "Removed. One undo brings them back.",
  libraryNothing: "There was nothing to remove.",
  editEnter: "Edit mesh",
  editDone: "Done",
  editCancel: "Cancel",
  editVertex: "Vertex",
  editEdge: "Edge",
  editFace: "Face",
  editExtrude: "Extrude",
  editDeleteFaces: "Delete faces",
  editFlip: "Flip normals",
  editStatus: "Editing — saves when you finish",
  editSaving: "Saving…",
  editToolbar: "Edit mesh tools",
  editSelectFirst: "Select one shape or part first, then press M.",
  editSelectFaces: "Select some faces first.",
  editKeepOneFace: "A mesh needs at least one face. Cancel to go back to the original.",
  editLocked: "This model is locked. Re-import it as editable parts to edit its mesh.",
  editNotMesh: "Only a shape or a part has a mesh to edit.",
  editHasClips: "This shape has animation clips, which a part cannot keep. Delete its clips first.",
  editTooLarge: "This mesh is too large to edit in the Hermes window (over 200,000 triangles).",
  editNoMesh: "This object has no mesh the editor can read.",
  editBecamePart: "This shape is now an editable mesh. Undo restores the original shape.",
  editConflict: "The scene changed while you were editing. Your edit was not saved.",
  editTooLargeToSave: "This mesh is too large to save from the editor.",
  editAssetCap: "This scene has too many models. Remove unused models, then try again.",
  editSaveFailed: "The edit could not be saved. It is still open, and a draft is kept.",
  editMarqueeTruncated: "The selection box stopped early on this dense mesh. Select a smaller area.",
  editDraftDropped: "An older unsaved edit was dropped to keep drafts under their size limit.",
  editDraftTooLarge: "This mesh is too large to keep a draft.",
  editDraftBroken: "The unsaved edit could not be read, so it was discarded.",
  editRestore: "Restore",
  editDiscard: "Discard",
  editRestoreOffer: "Restore unsaved edit from",
  editRestoreChanged: "This object changed since then. Restoring replaces the current mesh.",
  editGeneratorEnds: "Editing the mesh ends its settings. Continue?",
  editContinue: "Continue",
  animationInvalid: "These animation keys are invalid and cannot be played. Fix them before export.",
  animationPosition: "Position",
  animationRotation: "Rotation",
  animationScale: "Scale",
  animationDuration: "Duration",
  animationAddKey: "Add key",
  animationRemoveKey: "Remove key",
  animationAddChannel: "Add channel",
  animationDeleteClip: "Delete clip",
  animationCreateClip: "Create clip",
  clip: "Clip",
  play: "Play",
  pause: "Pause",
  restart: "Restart",
  saveAsGlb: "Save as GLB…",
  viewOnly: "These preferences change this view only. They are not written into the GLB. Preferences are saved separately in each browser profile and Desktop app.",
  keepLocked: "Keep as one locked model (required for animated, skinned, or morphing files)",
  storeTitle: "Plastis3D can't reach its scene store.",
  storeBody:
    "Turn on plastis3d under Capabilities → Plugins. A fresh install leaves it off.",
  storeRetry: "Hermes didn't answer. Check that Hermes is running, then try again.",
  noSceneTitle: "Make something in 3D",
  noSceneBody:
    "Try a sample, build from simple shapes, or bring in a model file (GLB, glTF, OBJ, STL or PLY). You can also ask Hermes to build a scene for you.",
  compressed:
    "This file uses Draco, Meshopt, or KTX2. Plastis3D can't decode those. Export an uncompressed glTF with buffers and images embedded and import that.",
  desktopCap:
    "The desktop reader has a size limit. For a larger file, use its full path on the Hermes computer.",
  tooLarge: "Too large to draw in the Hermes window.",
  storedNotDrawn: "Plastis3D stored this model but will not draw it.",
  notTriangles: "It isn't a triangle mesh.",
  locked:
    "This model is locked. You can move, rotate, and scale the whole model. Plastis3D does not edit the vertices inside it.",
  conflictDrag: "The scene changed. Your last drag was not applied.",
  conflictEdit: "The scene changed. Your edit was not applied.",
  externalBuffer:
    "This glTF points at a file outside itself. Embed the buffers and images, then import that file.",
  importFormat: "Plastis3D imports GLB, glTF, OBJ, STL and PLY in this version.",
  importIntro:
    "GLB, glTF with buffers and images embedded, OBJ, STL or PLY. Plastis3D does not rescale the file or change its axis. Print files (STL, OBJ) are often Z-up and in millimetres, so you may need to rotate and scale the model after you import it.",
  importNoFiles: "No .glb, .gltf, .obj, .stl or .ply files in this folder.",
  healthIntro:
    "Checks what a three.js game would hit when it loads this scene's GLB. It reads your scene and changes nothing.",
  healthRun: "Check this scene",
  healthRerun: "Check again",
  healthRunning: "Checking…",
  healthBudget: "Compare against",
  healthNumbers: "The numbers",
  healthScoreHint:
    "A rough guide against that budget. It is not proof the scene is compatible, and problems come first.",
  tidyButton: "Tidy up…",
  tidyIntro:
    "Merges materials that are identical, removes materials nothing uses, and removes empty groups. You can undo it.",
  weldButton: "Weld models…",
  weldIntro:
    "Merges vertices that are exactly alike (keeping seams and hard edges) and removes empty triangles in imported models. It makes a new model file and you can undo it.",
  weldApply: "Weld",
  weldLeftAlone: "Left alone",
  tidyApply: "Tidy up",
  tidyCancel: "Cancel",
  tidyNothing: "Nothing to tidy up.",
  tidyDone: "Tidied up. Undo (Ctrl or ⌘ Z) puts it back.",
  tidyFailed: "Plastis3D could not tidy this scene. Try again.",
  healthFailed: "Plastis3D could not run the check. Try again.",
  healthNotChecked: "Not checked",
  mapTitle: "Choose an image",
  mapIntro:
    "A PNG or JPEG picture to put on the surface. Up to 4096 pixels on a side and about 12 MB. Plastis3D copies it into your scene, so the original file can move or change later.",
  mapNoFiles: "No .png, .jpg or .jpeg pictures in this folder.",
  mapFormat: "Plastis3D reads PNG and JPEG pictures as textures.",
  mapUse: "Use this image",
  textureNoUv:
    "This model part has no texture coordinates, so a picture can't be put on it. Give it a plain material, or use a model that carries them.",
  importTileDesc: "Open a GLB, glTF, OBJ, STL or PLY file from this computer.",
  pathDenied: "Hermes refused that path.",
  pathRemote:
    "Hermes can't see that path. If the backend is another computer, ask the assistant to import a path on that computer, or pick a smaller file that fits the desktop size limit.",
  exportEmpty: "This scene has no meshes to export.",
  exportSparse: "The model uses sparse data Plastis3D doesn't export.",
  exportMode: "The model isn't triangles. Plastis3D exports triangles only.",
  exportMorph:
    "Plastis3D exports shape keys only when the model is kept as one locked piece, and only when they are well formed.",
  exportSkin:
    "Plastis3D exports a skin only when the model is kept as one locked piece and all of its bones belong to it.",
  exportAnim:
    "This model's animation points at something Plastis3D can't copy, so it can't be exported.",
  exportExtension: "The model uses an extension Plastis3D doesn't keep.",
  exportGeneric: "Plastis3D couldn't copy this model into the file.",
  exportIndex:
    "A texture index in this model points outside the part Plastis3D can copy.",
  exportScene: "This model has no scene Plastis3D can copy.",
  nodeLocked:
    "That part is inside an imported model. Move the model, or build the part from primitives.",
  busy: "Plastis3D is busy writing this scene. Try again in a moment.",
  limitNodes: "This scene is at the 2,000 node limit.",
  limitMaterials: "This scene is at the 256 material limit.",
  limitAssets: "This scene is at the 64 stored-model limit.",
  limitScene: "This scene file is at the 4 MB limit.",
  importNotFound: "Plastis3D couldn't find that file.",
  importTooLarge:
    "That file is over the size Plastis3D stores. One file stops at 256 MB. Every stored model together stops at 2 GB.",
  historyEmpty: "There is no earlier edit to undo or redo.",
  sceneExists: "A scene with that name already exists.",
  nodeMissing: "That node is no longer in the scene.",
  materialMissing: "That material is no longer in the scene.",
  rejected: "Plastis3D rejected that.",
  reparentKeptLocal: "Moved under {parent}. Its scale can’t hold this node’s pose, so the node moved. Undo puts it back.",
  newerSchema: "This scene was written by a newer Plastis3D.",
  createFirst: "Create a scene first.",
  noFilesDoor:
    "This Hermes window can't read a local folder. Use a path on the Hermes computer.",
  folderAgain:
    "That folder grant is no longer usable. Choose the folder again, or use a path on the Hermes computer.",
  hiddenExport: "Hidden here. Export still includes this node.",
  cardBadId: "No Plastis3D scene named “{id}”.",
  readmeSwitches:
    "Open Capabilities → Plugins → Plastis3D. Turn on the card switch, then open its detail and turn on both Desktop and Agent. A fresh install leaves both halves off.",
} as const;

export type CopyId = keyof typeof COPY;

/** The locked-internals sentence for a model node (exact text). */
export const LOCKED_SENTENCE =
  "This model is locked. You can move, rotate, and scale the whole model. Plastis3D does not edit the vertices inside it.";

export interface Toast {
  id: CopyId;
  message: string;
  kind: "warning" | "info";
}

const WARNING_IDS: ReadonlySet<CopyId> = new Set([
  "conflictDrag",
  "conflictEdit",
  "busy",
  "nodeLocked",
]);

const EXPORT_REASON_IDS: Record<string, CopyId> = {
  sparse: "exportSparse",
  mode: "exportMode",
  morph: "exportMorph",
  skin: "exportSkin",
  animation: "exportAnim",
  extension: "exportExtension",
  index: "exportIndex",
  scene: "exportScene",
};

/**
 * Map a gateway error code to its toast. `context` decides the
 * REVISION_CONFLICT sentence: a gizmo drag uses conflictDrag, any
 * other Desktop edit uses conflictEdit. `serverMessage` is the
 * gateway's message (appended only for `rejected`); `reason` is the
 * EXPORT_FAILED reason token (read from the body by src/api.ts).
 * Unknown codes use `rejected`; an unknown LIMIT_* also uses it.
 */
export function toastForCode(
  code: string,
  opts?: {
    context?: "drag" | "edit";
    serverMessage?: string;
    reason?: string;
  },
): Toast {
  const context = opts?.context ?? "edit";
  let id: CopyId;
  switch (code) {
    case "REVISION_CONFLICT":
      id = context === "drag" ? "conflictDrag" : "conflictEdit";
      break;
    case "STORE_BUSY":
      id = "busy";
      break;
    case "PATH_NOT_ON_BACKEND":
      id = "pathRemote";
      break;
    case "IMPORT_PATH_DENIED":
      id = "pathDenied";
      break;
    case "IMPORT_COMPRESSED":
      id = "compressed";
      break;
    case "IMPORT_EXTERNAL_BUFFER":
      id = "externalBuffer";
      break;
    case "IMPORT_FORMAT":
      id = "importFormat";
      break;
    case "IMPORT_NOT_FOUND":
      id = "importNotFound";
      break;
    case "IMPORT_TOO_LARGE":
      id = "importTooLarge";
      break;
    case "EXPORT_EMPTY":
      id = "exportEmpty";
      break;
    case "EXPORT_FAILED":
      id = EXPORT_REASON_IDS[opts?.reason ?? ""] ?? "exportGeneric";
      break;
    case "EXPORT_IMPORT_UNMERGED":
      id = "exportGeneric";
      break;
    case "HISTORY_EMPTY":
      id = "historyEmpty";
      break;
    case "LIMIT_NODES":
      id = "limitNodes";
      break;
    case "LIMIT_MATERIALS":
      id = "limitMaterials";
      break;
    case "LIMIT_ASSETS":
      id = "limitAssets";
      break;
    case "LIMIT_SCENE":
      id = "limitScene";
      break;
    case "SCENE_NOT_FOUND":
      id = "cardBadId";
      break;
    case "SCHEMA_NEWER":
      id = "newerSchema";
      break;
    case "SCENE_EXISTS":
      id = "sceneExists";
      break;
    case "NODE_NOT_FOUND":
      id = "nodeMissing";
      break;
    case "NODE_LOCKED":
      id = "nodeLocked";
      break;
    case "MATERIAL_NOT_FOUND":
      id = "materialMissing";
      break;
    case "TEXTURE_NO_UV":
      id = "textureNoUv";
      break;
    default:
      id = "rejected";
      break;
  }
  let message: string = COPY[id];
  if (id === "rejected") {
    const serverMessage = opts?.serverMessage ?? "";
    message =
      serverMessage !== "" ? `${message} ${serverMessage}` : `${message} ${code}`;
  }
  return { id, message, kind: WARNING_IDS.has(id) ? "warning" : "info" };
}

/** The cardBadId sentence with the id filled in. */
export function cardBadIdMessage(id: string): string {
  return `No Plastis3D scene named “${id}”.`;
}

/** PR33 onboarding copy; prompt chips insert these words without submitting. */
export const LEARNING_COPY = {
 createPrompts: ["Build a cozy cabin with a glowing window", "Make a little forest of low-poly trees", "Build a rocket on a launch pad"],
 editPrompts: ["Make this scene feel like evening", "Add three more of the selected object in a row"],
 copied: "Copied. Paste it into a chat with Hermes.",
 ask: "Or ask Hermes:", heading: "Getting started", hide: "Hide", complete: "You're set. Have fun!",
 steps: [["look","Look around"],["select","Select something"],["move","Move something"],["color","Give it a colour"],["save","Save as GLB or ask Hermes to change it"]],
 shortcuts: "Keyboard shortcuts", tools: "Tools", view: "View", edit: "Edit", close: "Close",
 toolKeys: "Q Select · W Move · E Rotate · R Scale · Shift+A Add", viewKeys: "F Frame · G Grid · H Hide/show selection · ? Shortcuts", editKeys: "Delete Remove · Mod+D Duplicate · Mod+Z Undo · Mod+Shift+Z Redo · Escape Cancel or blur", mesh: "Edit mesh", meshKeys: "M Edit mesh or Done · B Sculpt · P Paint · [ ] Brush size · 1 Vertex · 2 Edge · 3 Face · Shift+drag Select with a box · Delete Delete faces",
 tips: { add: "New things land on the floor where you're looking.", undo: "Every change can be undone (⌘Z).", locked: "This model is locked. Re-import with editable parts to change its pieces.", cap: "Too large to draw in the Hermes window. The scene is saved.", move: "Drag an arrow to move along one direction, or a square to slide across a flat plane.", multi: "Shift-click to select several." },
 dismiss: "Got it", reassurance: "Everything is saved as you go, and every change can be undone.",
} as const;

export const RENDER_COPY = { render: 'Render', preview: 'Back to editing', save: 'Save image…', samples: 'samples', checking: 'Checking GPU support…', software: 'Render and splats require a hardware GPU; this renderer uses software.', float: 'Render and splats require WebGL2 with floating-point colour support.', probe: 'The GPU did not complete the required test render.', splats: 'Gaussian splats are unavailable on this GPU.', saving: 'Saving image…', failed: 'The render could not be saved.', renderFailed: 'The GPU could not render this scene.', meshOnly: 'Render traces meshes; Gaussian splats are shown in editing mode.', cap: 'Render supports at most 200,000 triangles.' } as const;

export const SPLAT_COPY = { title: "Splat", detail: "Gaussian splats support transforms and visibility. They are omitted from GLB exports.", file: "File", count: "Splats" } as const;
