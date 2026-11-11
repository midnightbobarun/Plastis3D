# Plastis3D 0.1.0

A free, local 3D scene viewer and editor inside Hermes. Build with primitives, import GLB, embedded glTF, OBJ, STL or PLY, and edit imported parts. Ask Hermes to build or change a scene, or use the editor yourself. This is not a neural generator and contacts no network service.

## Enable

Open Capabilities → Plugins → Plastis3D. Turn on the card switch, then open its detail and turn on both Desktop and Agent. A fresh install leaves both halves off.

Closing both plugin panes turns the Desktop half off. Scene data stays on the Hermes machine.

## Create and edit

The welcome screen offers Snowman, Desk lamp, Little rocket and Cozy cabin samples, an empty scene, or model import. Prompt chips insert requests into chat without sending them. A getting-started checklist, dismissible coach tips and the ? shortcut sheet help you learn. The tool dock offers Select, Move, Rotate and Scale. Use the Add panel to add shapes, groups, lights and cameras. Material presets and swatches live in Properties. The View menu offers framing, background and quality controls. Snap controls set movement, rotation and scale increments. Scene names can be changed with undo support. External edits show what changed, with Show and Undo last. Settings → Plugins → Plastis3D provides view preferences and keyboard help.

Scenes save automatically. **Save as GLB…** writes a file where you choose. The agent export returns a path on the Hermes machine. Exported GLB does not round-trip back into editable primitives.

View preferences affect previews only, not scene data or exports. They are saved separately in each browser profile and Desktop app, with live updates across mounted plugin views in that surface.

## Formats and limits

| Import | What is read |
| --- | --- |
| GLB, glTF | Buffers and images must be embedded. A `.gltf` is stored as a GLB. |
| STL | ASCII and binary little-endian. One mesh, flat shaded. |
| OBJ | Positions, texture coordinates, normals and faces; n-gons are split into triangles. One mesh with the first material only. The colour (`Kd`, `d`) comes from the `.mtl` beside the file. Texture images are not read. |
| PLY | ASCII, binary little-endian and binary big-endian. Vertex colours and normals are kept. |

OBJ, STL and PLY are read as one mesh, with no axis or unit conversion. Print files are often Z-up and in millimetres: rotate the model −90° about X and set scale 0.001 if that is what you have. A model that is too large to draw is still saved, with its bounds.

Imports become editable parts by default; use `explode: false` to keep one locked model. Animated, skinned and morphing files require the locked option. No automatic unit or axis guessing: meters, Y-up.

The desktop picker accepts about 12 MB per file (12,582,864 raw bytes after base64 expansion). Larger files use an absolute path on the Hermes machine. The provisional view cap is 100,000 imported triangles and 12 MiB per asset: larger stored models show bounds and explanatory overlays. Stored triangles include models that are not drawn.

In **Maps**, choose an image from this computer or a granted folder. The optional **Resize uploaded image** setting shows the original/result dimensions before you apply it. It preserves aspect ratio and creates an 8-bit PNG, within the existing 4096-side texture limit. Resize sources are limited to 8192 pixels per side and 32,000,000 pixels; larger sources need an image editor. Data maps must be opaque, and 16-bit data maps are refused to preserve precision. The original file is unchanged.

**Textures.** In the material section, **Maps** takes a PNG or JPEG for four slots: Picture (colour), Bumps (normal), Shine and metal, and Glow picture. Pictures are copied into the scene, up to 4096 pixels on a side and about 12 MB, and four full-size pictures per scene. Shapes carry texture coordinates; a part of an imported model needs the model's own. Save as GLB embeds the pictures. The agent cannot add a picture (it points you at the editor) but can swap or clear one already in the scene.

Compressed glTF (Draco, Meshopt, KTX2), external buffers and external images are refused. Save as GLB keeps the skins, animation clips and morph targets of a model you kept locked (one copy per instance); it refuses sparse data, non-triangle modes, unsupported required extensions, and an animation or skin that points outside the model. Primitive meshes can be keyed in the editor; their clips play in the stage and export with the GLB. Rotation keys use shortest-path quaternion interpolation. UV editing and agent screenshots are available as described below; texture resizing is not implemented.

## Checking a scene

**Health** (bottom of the inspector, closed until you open it) runs a compatibility check on request: what a three.js game would hit when it loads the scene's GLB. Findings are errors (a required or compressed extension, a file outside the glTF, a broken transform), warnings (missing normals, over 100,000 or 500,000 triangles, degenerate triangles, many materials, a model that may not be in meters) and notes (a texture over 2048 pixels). Anything it could not check is listed, so an empty list never hides a gap. Below the findings, Health shows the measured numbers (triangles, an estimate of draw calls, materials, texture memory) against a budget you choose, Phone or Desktop, and a 0 to 100 **heuristic** score for it. The score is a rough guide, not a certificate, and it is withheld while there is a hard problem. The agent has the same two tools, `plastis3d_check_gltf` and `plastis3d_analyze`. They read your scene and change nothing.

**Tidy up…** (in Health) merges materials that are identical, removes materials nothing uses (never the default one) and removes empty groups. It shows what it will do first, then applies it as one step you can undo. The agent has it as `plastis3d_cleanup`. It does not touch meshes or imported models.

**Weld models…** (also in Health) merges the vertices of imported models that are exactly alike and removes empty triangles, which can make a file smaller. It never merges vertices that differ in position, normal, UV or colour, so UV seams and hard edges stay. It skips built-in shapes and models with skins, animations or morph targets, and says so. It writes a new copy of the model (the old file stays until a later cleanup) and you can undo it. The agent has it as `plastis3d_cleanup` with the `weld` operation.

**Library.** With more than five scenes the scene picker and the Scenes pane show a search box that filters by name. Each scene shows a small preview picture (drawn by the editor a few seconds after an edit settles) in place of its letter tile. With nothing selected, the inspector's **Files in this scene** lists the models and images the scene holds and whether anything uses them; **Remove unused** shows what it would drop, then drops those entries as one step you can undo. A file leaves the disk only later, once no scene, undo step or unsaved copy needs it.

**Settle.** Select up to 32 shapes and press Settle: they drop under gravity onto the floor and onto the other shapes, and you see it happen. Keep writes where they ended up as one undo step; Keep and record the fall also saves the fall as an animation on each built-in shape; Cancel puts everything back. Parts and models are treated as boxes.

**Rig.** Select a shape or part, open Rig in the inspector and set bones (a head and a tail, with a parent) and a clip of bone rotations; Apply turns the shape into a locked model that bends along those bones and plays the clip. Open Rig again to change the bones. Mesh edit does not apply to the rigged model; undo returns the plain shape. Save as GLB keeps the skin and the clip.

**Curves, clones and noise (the assistant can do these).** Add, then Curve, makes a tube along a smooth line through points you set (the Curve section lists the points; change a number and Apply; switch the kind to Lathe to revolve a profile). The assistant also has `plastis3d_curve`, `plastis3d_clone` (copies in a grid, a line or a ring) and `plastis3d_displace` (seeded noise on a surface). Copies are real objects you can move; displaced and curved results are ordinary editable parts, and the original mesh behind a displacement is kept so it can be changed again.

**Sculpt and Paint.** Select a shape or part and press **B** to sculpt or **P** to paint (**M** goes back to the mesh tools). Sculpt has Draw, Smooth, Flatten and Grab brushes with a radius (in screen pixels, **[** and **]** change it), strength and a mirror across X; the shape's faces stay the same, only the points move. Paint puts colour on the vertices with a radius, strength, hardness and mirror, and Fill colours everything. Strokes stay in the editor until you finish (**M** or Escape), then save as one step you can undo, and Cancel throws them away. Painted colours are saved in the model (Save as GLB writes them as vertex colours). The assistant has no tool for sculpting or painting.

**UV map.** The inspector's UV map section unwraps a shape or part into islands (cutting along its seams and, if you leave it on, edges sharper than 66 degrees), packs them into the square, repairs flipped or broken islands, and lets you nudge, turn or resize one island. Apply saves it as one step with texture coordinates, which is what lets a model that came without them take a texture. In edit mode, **Mark seam** (edge selection) cuts the surface along the edges you chose. The assistant has no tool for UVs.

**Modifiers.** Select a shape or part and use the inspector's Modifiers section: add Mirror, Array, Subdivide, Smooth, Decimate or Edge split, reorder, switch off or remove them, and change their settings. The size the stack would make is shown as you edit and refused over 100,000 triangles. Apply keeps the original mesh as a hidden base and builds the result from it, so you can change the stack later without losing anything. A built-in shape becomes an editable part the first time. Decimate and Edge split do not keep texture coordinates. The assistant has no tool for modifiers.

**Text.** Add, then Text, makes 3D letters in the bundled font (Latin-1 characters). The Text section in the inspector sets the words (several lines allowed), size, depth, line height, curve detail, alignment and a bevel. Apply, Enter or leaving a field builds it as one step you can undo. A character the font does not have is named, and nothing is built. The letters are an ordinary part, so Save as GLB includes them. The assistant has no tool for text.

**Edit mesh** (select a shape or part, press **M**) changes the shape's actual faces, edges and corners. **1**, **2** and **3** choose vertex, edge or face; click to select, Shift-click to add, Shift-drag for a box. Move, rotate and scale the selection with the usual tools, **Extrude** or **Delete faces**, or **Flip normals**. Nothing is saved while you work (the status reads "Editing — saves when you finish"); **M** or Escape finishes and saves it as one step, and Cancel throws it away. A built-in shape becomes an editable part when you finish, and one undo brings the original shape back. About every two minutes, and when the window is hidden, an unsaved copy is kept so a crash does not lose your work, and you are offered it back. Locked models, shapes with animation clips, and meshes over 200,000 triangles cannot be edited this way. The assistant has no tool for it. Old model files that no scene uses are deleted from the plugin data folder as you save.

**Screenshots for the agent.** The assistant can ask for a picture of a scene with `plastis3d_screenshot`. It needs the scene open in Hermes (the editor or the Plastis3D pane, visible). The picture is a clean view of your scene, without the grid or handles, saved as a PNG under `screenshots/` in the plugin data folder (the newest 20 per scene are kept). If nothing is open it says so after about 12 seconds instead of waiting.

## Privacy and file access

In plain words: Plastis3D makes no network calls and sends nothing anywhere. It keeps your scenes, the models and images you import, small preview pictures of your scenes, the latest render PNG you save for each scene, and short-lived copies of edits you have not saved in one folder, `plugin-data/plastis3d`, which stays when you uninstall it. It cleans up files in that folder that no scene needs, and nothing else. It reads files from elsewhere only when you pick them or you or the assistant give a path. The assistant's screenshot tool is the one tool that waits for you (up to about 12 seconds). The exact statement the plugin ships with follows.

Disclosure — no network calls, no telemetry, no credentials, no shell commands, no background processes. Stores scenes and copies of the models and images you import, small preview pictures of your scenes, the latest saved render PNG per scene, and unsaved-edit drafts, in `<HERMES_HOME>/plugin-data/plastis3d/`, which is kept after the plugin is removed. It deletes model and image files from that folder only, and only when no scene uses them any more (after you save an edit, or when old undo history rolls off); it never deletes anything you picked from elsewhere. Each export writes a GLB under `exports/`, replacing that scene's previous export; the durable copy is the one the host save dialog writes where you choose. Reads a model, a texture image, or an OBJ's `.mtl` material file outside that folder only when you pick it from a folder you granted in the Desktop file picker (revocable under Capabilities → Plugins → Folder access; a desktop pick is limited to about 12 MB per file, larger files use a path on the Hermes machine, and granted folders are read-only) or when you or the assistant pass an absolute path to `plastis3d_import_model` on the Hermes backend machine, or you type an image's path into the editor's image picker, or you choose one image file in the browser's file picker (no persistent folder grant). Tools only edit scene data, with one exception: `plastis3d_screenshot` waits up to about 12 seconds for an open scene view to answer, then stores a PNG of that view under `screenshots/` (the newest 20 per scene are kept). Tools run on every surface, including cron and the gateway; with no open view the screenshot tool returns DESKTOP_UNAVAILABLE instead of hanging, and no other tool waits for the viewport. Compressed glTF (Draco, Meshopt, KTX2) is refused.

## Development

Build with `npm install` then `npm run build:desktop`. Run `npm run typecheck`, `npm run lint:desktop`, `npm run test:node`, `python -m pytest tests/python`, and `npm run test:harness`.

MIT; see [LICENSE](LICENSE). Internal documentation and one-off development scripts are kept locally and excluded from Git. Runtime files, source, build tools, automated tests, and third-party notices are included.

### Render and Gaussian splats

The editor offers GPU-gated progressive Render mode (up to 256 samples and 2048 pixels on the long side). Save image stores the latest render PNG for the scene before opening the host save dialog. Import `.splat` or binary little-endian Gaussian `.ply` through the existing import dialog or agent tool. Splats have transforms and visibility, and GLB exports omit them with an explicit ignored entry. Render traces meshes; splats are drawn in editing mode. Gaussian previews use the existing approximately 12 MiB asset-download cap. Software renderers show the reason these features are unavailable.
