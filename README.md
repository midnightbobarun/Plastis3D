# Plastis3D 0.1.0

A free, local 3D scene viewer and editor inside Hermes. Build with primitives, import GLB, embedded glTF, OBJ, STL or PLY, and edit imported parts. Ask Hermes to build or change a scene, or use the editor yourself. This is not a neural generator and contacts no network service.

## Install and enable

Requires **Hermes 0.23.0 or newer**. In Hermes Desktop, open **Capabilities → Plugins → Install from Git**, enter this repository's Git URL, and install its Desktop and Agent components. The repository includes the built `desktop/plugin.js`; users do not need Node.js, npm, or a local build to install it. See [Hermes' plugin installation guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins) for CLI installation and private-repository authentication.

Open Capabilities → Plugins → Plastis3D. Turn on the card switch, then open its detail and turn on both Desktop and Agent. A fresh install leaves both halves off.

The **Scenes** pane lists your scenes; the viewport pane previews the selected scene. Press **Editor** to open the full editor. While the editor is open, the companion pane carries its outline and properties.

To dismiss either pane, **right-click the pane and choose Close**. Closing both plugin panes turns the Desktop half off; re-enable it under Capabilities → Plugins when needed. Closing or disabling the UI does not delete saved scenes.

## Create and edit

The welcome screen offers Snowman, Desk lamp, Little rocket and Cozy cabin samples, an empty scene, or model import. A getting-started checklist, dismissible coach tips and the **?** shortcut sheet help you learn. The tool dock offers Select, Move, Rotate and Scale. Use **Add** for seven primitive shapes, groups, lights, cameras, text and curves. Material presets and swatches live in Properties. The View menu offers framing, background and quality controls. Snap controls set movement, rotation and scale increments. Scene names can be changed with undo support. External edits show what changed, with Show and Undo last. Settings → Plugins → Plastis3D provides view preferences and keyboard help.

**Ask Hermes and the suggested-prompt chips are temporarily hidden** while the chat handoff is being improved. You can still ask Hermes for scene changes directly in its normal chat; the Agent tools remain available.

Scenes save automatically. **Open…** loads a model into the current scene; **Save…** exports the scene as a GLB file where you choose. The agent export returns a path on the Hermes machine. A GLB is an interchange file: reimporting it does not restore the original primitive parameters or editing history.

View preferences affect previews only, not scene data or exports. They are saved separately in each browser profile and Desktop app, with live updates across mounted plugin views in that surface.

## Formats and limits

| Import | What is read |
| --- | --- |
| GLB, glTF | Buffers and images must be embedded. A `.gltf` is stored as a GLB. |
| STL | ASCII and binary little-endian. One mesh, flat shaded. |
| OBJ | Positions, texture coordinates, normals and faces; n-gons are split into triangles. One mesh with the first material only. When imported by backend path, the colour (`Kd`, `d`) comes from the `.mtl` beside the file. The file picker imports the OBJ alone, without its `.mtl`. Texture images are not read. |
| PLY | ASCII, binary little-endian and binary big-endian. Vertex colours and normals are kept. |
| Gaussian PLY, SPLAT | Binary little-endian Gaussian PLY and `.splat` become splat nodes; see Render and Gaussian splats below. |

OBJ, STL and ordinary mesh PLY are read as one mesh, with no axis or unit conversion. Print files are often Z-up and in millimetres: rotate the model −90° about X and set scale 0.001 if that is what you have. A model that is too large to draw is still saved, with its bounds.

Imports become editable parts by default; use `explode: false` to keep one locked model. Animated, skinned and morphing files require the locked option. No automatic unit or axis guessing: meters, Y-up.

The desktop picker accepts roughly 12 MiB per file; base64 encoding and request overhead reduce the usable size slightly. For larger model files, expand **Import using a path** and enter an absolute path on the Hermes machine. The imported-model preview cap is 100,000 triangles and approximately 12 MiB per asset: larger stored models show bounds and explanatory overlays. Stored triangle counts include models that are not drawn. Scenes are limited to 2,000 nodes, 256 materials and 64 assets.

## Textures and image resizing

Select an object and open **Textures** in Properties. Press **Choose…** or **Replace** for a slot, then **Choose an image file…** to open the system file picker. Hermes or the operating system may request file-access permission first. You can also choose from a granted folder or enter an image path on the Hermes computer. Manage folder grants under **Capabilities → Plugins → Folder access**.

The optional **Resize uploaded image** setting shows the original/result dimensions before you apply it. It preserves aspect ratio and creates an 8-bit PNG within the 4096-pixel side limit. Resize sources are limited to 8192 pixels per side and 32,000,000 pixels; larger sources need an image editor. Resizing data maps requires opaque images and refuses 16-bit data maps to preserve precision. The original file is unchanged.

The four PNG/JPEG slots are **Picture** (colour), **Bumps** (normal), **Shine and metal** (metallic/roughness), and **Glow picture** (emission). Images are copied into the scene, up to 4096 pixels on a side and roughly 12 MiB each. The combined pixel budget for images used by materials is equivalent to four 4096 × 4096 images; smaller images can share that budget. Shapes carry texture coordinates; imported parts need UVs from their model or from the UV map tools. GLB export embeds the pictures. The agent cannot load a new image file, but can swap or clear an image already stored in the scene.

An imported model shows the materials and embedded images carried by its file. Materials or textures assigned separately by a game's code are not reconstructed automatically; choose those images in the editor if you want to preview them here.

## Animation and GLB export

Compressed glTF (Draco, Meshopt, KTX2), external buffers and external images are refused. GLB export keeps the skins, animation clips and morph targets of a model you kept locked (one copy per instance); it refuses sparse data, non-triangle modes, unsupported required extensions, and an animation or skin that points outside the model. Primitive meshes can be keyed in the editor; their clips play in the stage and export with the GLB. Rotation keys use shortest-path quaternion interpolation.

## Checking a scene

**Health** (bottom of the inspector, closed until you open it) runs a compatibility check on request: what a three.js game would hit when it loads the scene's GLB. Findings are errors (a required or compressed extension, a file outside the glTF, a broken transform), warnings (missing normals, over 100,000 or 500,000 triangles, degenerate triangles, many materials, a model that may not be in meters) and notes (a texture over 2048 pixels). Anything it could not check is listed, so an empty list never hides a gap. Below the findings, Health shows the measured numbers (triangles, an estimate of draw calls, materials, texture memory) against a budget you choose, Phone or Desktop, and a 0 to 100 **heuristic** score for it. The score is a rough guide, not a certificate, and it is withheld while there is a hard problem. The agent has the same two tools, `plastis3d_check_gltf` and `plastis3d_analyze`. They read your scene and change nothing.

**Tidy up…** (in Health) merges materials that are identical, removes materials nothing uses (never the default one) and removes empty groups. It shows what it will do first, then applies it as one step you can undo. The agent has it as `plastis3d_cleanup`. It does not touch meshes or imported models.

**Weld models…** (also in Health) merges the vertices of imported models that are exactly alike and removes empty triangles, which can make a file smaller. It never merges vertices that differ in position, normal, UV or colour, so UV seams and hard edges stay. It skips built-in shapes and models with skins, animations or morph targets, and says so. It writes a new copy of the model (the old file stays until a later cleanup) and you can undo it. The agent has it as `plastis3d_cleanup` with the `weld` operation.

**Library.** With more than five scenes the scene picker and the Scenes pane show a search box that filters by name. Each scene shows a small preview picture (drawn by the editor a few seconds after an edit settles) in place of its letter tile. With nothing selected, the inspector's **Files in this scene** lists the models and images the scene holds and whether anything uses them; **Remove unused** shows what it would drop, then drops those entries as one step you can undo. A file leaves the disk only later, once no scene, undo step or unsaved copy needs it.

## Modeling tools

**Settle.** Select up to 32 shapes, parts or models and press Settle to preview them falling under gravity onto the floor at Y = 0 and other objects. **Keep** saves the final positions as one undo step; **Keep and record the fall** also saves a fall animation on built-in shapes. **Cancel** restores the starting positions. Collisions are approximate: spheres use spheres, and other objects, including imported parts and models, use boxes. This can move an individual part away from an assembled model or outside the current camera view.

**Rig.** Select a shape or part, open Rig in the inspector and set bones (a head and a tail, with a parent) and a clip of bone rotations; Apply turns the shape into a locked model that bends along those bones and plays the clip. Open Rig again to change the bones. Mesh edit does not apply to the rigged model; undo returns the plain shape. Save as GLB keeps the skin and the clip.

**Curves, clones and noise (the assistant can do these).** Add, then Curve, makes a tube along a smooth line through points you set (the Curve section lists the points; change a number and Apply; switch the kind to Lathe to revolve a profile). The assistant also has `plastis3d_curve`, `plastis3d_clone` (copies in a grid, a line or a ring) and `plastis3d_displace` (seeded noise on a surface). Copies are real objects you can move; displaced and curved results are ordinary editable parts, and the original mesh behind a displacement is kept so it can be changed again.

**Sculpt and Paint.** Select a shape or part and press **B** to sculpt or **P** to paint. The editing toolbar switches between Mesh, Sculpt and Paint. Sculpt has Draw, Smooth, Flatten and Grab brushes with a radius (in screen pixels, **[** and **]** change it), strength and a mirror across X; the shape's faces stay the same, only the points move. Paint puts colour on the vertices with a radius, strength, hardness and mirror, and Fill colours everything. Strokes stay in the editor until you finish, then save as one step you can undo; Cancel throws them away. Painted colours are saved in the model and exported as vertex colours. The assistant has no tool for sculpting or painting.

**UV map.** The inspector's UV map section unwraps a shape or part into islands (cutting along its seams and, if you leave it on, edges sharper than 66 degrees), packs them into the square, repairs flipped or broken islands, and lets you nudge, turn or resize one island. Apply saves it as one step with texture coordinates, which is what lets a model that came without them take a texture. In edit mode, **Mark seam** (edge selection) cuts the surface along the edges you chose. The assistant has no tool for UVs.

**Modifiers.** Select a shape or part and use the inspector's Modifiers section: add Mirror, Array, Subdivide, Smooth, Decimate or Edge split, reorder, switch off or remove them, and change their settings. The size the stack would make is shown as you edit and refused over 100,000 triangles. Apply keeps the original mesh as a hidden base and builds the result from it, so you can change the stack later. A built-in shape becomes an editable part the first time. Modifier processing carries UVs and vertex colours; Decimate refuses non-opaque vertex colours because it cannot preserve their alpha. The assistant has no tool for modifiers.

**Text.** Add, then Text, makes 3D letters in the bundled font (Latin-1 characters). The Text section in the inspector sets the words (several lines allowed), size, depth, line height, curve detail, alignment and a bevel. Apply, Enter or leaving a field builds it as one step you can undo. A character the font does not have is named, and nothing is built. The letters are an ordinary part, so Save as GLB includes them. The assistant has no tool for text.

**Edit mesh** (select a shape or part, press **M**) changes the shape's actual faces, edges and corners. **1**, **2** and **3** choose vertex, edge or face; click to select, Shift-click to add, Shift-drag for a box. Move, rotate and scale the selection with the usual tools, **Extrude** or **Delete faces**, or **Flip normals**. Nothing is saved while you work (the status reads "Editing — saves when you finish"); **M** or Escape finishes and saves it as one step, and Cancel throws it away. A built-in shape becomes an editable part when you finish, and one undo brings the original shape back. About every two minutes, and when the window is hidden, an unsaved copy is kept so a crash does not lose your work, and you are offered it back. Locked models, shapes with animation clips, and meshes over 200,000 triangles cannot be edited this way. The assistant has no tool for it. Old model files that no scene uses are deleted from the plugin data folder as you save.

## Working with the agent

With the Agent half enabled, ask Hermes in its normal chat to create or change scenes. The plugin registers these tools:

| Task | Tools |
| --- | --- |
| Find, create and inspect scenes | `plastis3d_list_scenes`, `plastis3d_new_scene`, `plastis3d_get_scene` |
| Build and change objects and materials | `plastis3d_build_scene`, `plastis3d_add_node`, `plastis3d_update_node`, `plastis3d_set_material` |
| Copy, remove and undo | `plastis3d_duplicate_node`, `plastis3d_delete_node`, `plastis3d_undo`, `plastis3d_redo` |
| Import, open and export | `plastis3d_import_model`, `plastis3d_open_in_desktop`, `plastis3d_export_glb` |
| Check and clean up | `plastis3d_check_gltf`, `plastis3d_analyze`, `plastis3d_cleanup` |
| Generate curves, copies and noise displacement | `plastis3d_curve`, `plastis3d_clone`, `plastis3d_displace` |
| Capture an open scene | `plastis3d_screenshot` |

The agent can also rename scenes and set animation clips on primitive meshes. Geometry editing, sculpting, painting, UV editing, modifier stacks, text, rigging, Settle, rendering and choosing new texture files are editor actions rather than dedicated agent tools. The agent skill supplies scene/revision handling and guidance for those boundaries. Agent replies can include an interactive scene card with an **Open in editor** action.

**Screenshots for the agent.** `plastis3d_screenshot` needs the scene open in Hermes (the editor or the Plastis3D pane, visible). The picture is a clean view of your scene, without the grid or handles, saved as a PNG under `screenshots/` in the plugin data folder (the newest 20 per scene are kept). If nothing is open, the request times out after about 12 seconds.

## Render and Gaussian splats

The editor offers progressive **Render** mode on supported hardware GPUs, up to 256 samples and 2048 pixels on the long side, with a 200,000-triangle limit. **Save image…** stores the latest render PNG for the scene before opening the host save dialog. Availability is checked at runtime; software renderers and unsupported GPUs show the reason the feature is unavailable.

Import `.splat` or binary little-endian Gaussian `.ply` through the import dialog or agent tool. Splats support transforms and visibility, and **GLB exports omit them with an explicit report**. Render traces meshes; splats are drawn in editing mode. Gaussian previews use the existing approximately 12 MiB asset-download cap and also require supported GPU features.

## Privacy and file access

In plain words: Plastis3D makes no network calls and sends nothing anywhere. It keeps your scenes, the models and images you import, small preview pictures of your scenes, the latest render PNG you save for each scene, and short-lived copies of edits you have not saved in one folder, `plugin-data/plastis3d`, which stays when you uninstall it. It cleans up files in that folder that no scene needs, and nothing else. It reads files from elsewhere only when you pick them or you or the assistant give a path. The assistant's screenshot tool is the one tool that waits for you (up to about 12 seconds). The exact statement the plugin ships with follows.

Disclosure — no network calls, no telemetry, no credentials, no shell commands, no background processes. Stores scenes and copies of the models and images you import, small preview pictures of your scenes, the latest saved render PNG per scene, and unsaved-edit drafts, in `<HERMES_HOME>/plugin-data/plastis3d/`, which is kept after the plugin is removed. It deletes model and image files from that folder only, and only when no scene uses them any more (after you save an edit, or when old undo history rolls off); it never deletes anything you picked from elsewhere. Each export writes a GLB under `exports/`, replacing that scene's previous export; the durable copy is the one the host save dialog writes where you choose. Reads a model, a texture image, or an OBJ's `.mtl` material file outside that folder only when you pick it from a folder you granted in the Desktop file picker (revocable under Capabilities → Plugins → Folder access; a desktop pick is limited to about 12 MB per file, larger files use a path on the Hermes machine, and granted folders are read-only) or when you or the assistant pass an absolute path to `plastis3d_import_model` on the Hermes backend machine, or you type an image's path into the editor's image picker, or you choose one image file in the browser's file picker (no persistent folder grant). Tools only edit scene data, with one exception: `plastis3d_screenshot` waits up to about 12 seconds for an open scene view to answer, then stores a PNG of that view under `screenshots/` (the newest 20 per scene are kept). Tools run on every surface, including cron and the gateway; with no open view the screenshot tool returns DESKTOP_UNAVAILABLE instead of hanging, and no other tool waits for the viewport. Compressed glTF (Draco, Meshopt, KTX2) is refused.

## Development

Only contributors need a local build environment. With Node.js/npm installed, run `npm ci` followed by `npm run build:desktop`. This rebuilds `desktop/plugin.js` and the third-party notices from the included source and lockfile.

Checks:

```sh
npm run typecheck
npm run lint:desktop
npm run test:node
python -m pytest tests/python
npx playwright install chromium
npm run test:harness
hermes plugins validate .
```

Python tests require a Python environment with pytest and the Hermes backend's test dependencies; browser tests require Playwright's Chromium. Some Node tests invoke Python, preferring `.venv/bin/python` or `.venv/Scripts/python.exe` when present. The browser harness uses a mock Hermes host; passing it does not replace testing the installed plugin in Hermes Desktop.

MIT; see [LICENSE](LICENSE). Internal documentation and one-off development scripts are kept locally and excluded from Git. Runtime files, source, build tools, automated tests, and third-party notices are included.
