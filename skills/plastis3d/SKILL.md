---
description: use when the user asks to create, change, view, import, or export a 3D scene or model inside Hermes
---

# Plastis3D

Build, edit, view, import, and export 3D scenes inside Hermes. Plastis3D is a local editor: the agent builds scenes out of primitives and files already on disk. It does not generate a textured mesh, and it does not claim to.

## Units and orientation

Units are meters, Y-up, right-handed, Euler degrees. Local minus Z is the camera and light forward direction.

## Workflow

List scenes or create a new scene, then get the scene, then build a new layout with build_scene or change one thing with update_node or set_material. Use stable node ids and check the feedback envelope after each write. Always pass baseRevision from the get_scene result. On a revision conflict, get the scene once and retry once. Then stop and tell the user.

## Recipes

A snowman about 1.8 m tall: three spheres, a cone hat, and a thin box or cylinder scarf. A 1 m crate: a box plus a slightly larger lid. A floor: a plane with rotation minus 90, 0, 0. The default cam_main and light_key already look at the origin. Do not leave them at identity rotation if you replace them. new_scene creates the aimed rig. build_scene writes exactly the supplied nodes; copy cam_main and light_key from get_scene into the payload to keep them. Rebuilding without them removes them, and deleting nodes adds nothing back. Include a light for an illuminated standalone scene.

## Import, in this version

Ask for an absolute path on the machine where Hermes runs. Accept GLB, glTF with buffers and images embedded, OBJ, STL, and PLY. Plastis3D does not rescale or re-axis a file. If a file was built in millimeters, set the model node scale to 0.001. If the result code is IMPORT_COMPRESSED or EXPORT_FAILED because of Draco, Meshopt, KTX2, sparse data, or a non-triangle mode, say so and stop. Clips on locked models can be played and scrubbed in the editor without changing the scene. Skins, animation clips, and morph targets export when the model is kept locked (explode: false); an exploded part of a skinned or morphing mesh cannot be exported. Do not try to decompress the file. OBJ, STL, and PLY arrive as one mesh. STL and OBJ files are often Z-up and in millimeters: offer scale 0.001 and a rotation of -90 degrees about X, and do not expect the importer to stand the file up. An OBJ keeps its first material only, and its textures are not imported. A model that is too large to draw is still saved; say so. If a file is refused with IMPORT_FORMAT or IMPORT_TOO_COMPLEX, report the reason and stop.

Textures are an editor feature: pictures are chosen in Maps in the material section, because no tool reads an image off disk. plastis3d_set_material can swap a map to an image already in the scene (use the asset id from get_scene) or clear it with null. If a user asks you to put a picture on something, tell them to use Maps in the editor and say that PNG and JPEG are supported, up to 4096 pixels on a side. A part of an imported model can carry a picture only if the model has texture coordinates; TEXTURE_NO_UV means it does not, so say so and stop.

Imports become editable parts by default. Use get_scene to find part ids, then update_node or set_material to move, hide, rename, or recolor individual parts. Use explode: false to keep one locked model; animated, skinned, and morphing files require that option. If the import refuses to explode those features, retry once with explode: false and explain that the model is one locked piece. For a prop a game will load into its own scene, omit lights and cameras. Keep the rig for a scene meant to be viewed as-is.

## After a build or edit

After a successful build or edit that produces an assistant transcript reply, report Saved scene <id> at revision <n>, meters, Y-up, the stored triangle count, and a short description of what changed in one prose paragraph, followed by a paragraph whose only content is a Plastis3D directive for the scene, in this form:

::plastis3d{scene="snowman"}

The scene id in the directive matches lowercase letters, digits, and hyphens, 1 to 64 characters. Cron and other non-transcript invocations return their normal envelope. They do not append a directive to a job result.

## Export

To check whether a scene or an imported model is safe for a three.js game, call plastis3d_check_gltf (it only reads; it needs no baseRevision). Quote its findings and the "unchecked" list as they are; do not add checks of your own, and do not call a scene fine if the list is not empty. If a finding names a file outside the glTF, a compression extension, or a missing file, say so and stop; those are the user's to fix.

To tidy a scene, call plastis3d_cleanup. Use dryRun=true first when you are not sure, tell the user what it would merge and remove (quote the cleanup block), then run it for real with the same baseRevision. It merges identical materials, removes unused materials (never m_default) and removes empty groups, in one undoable step; it does not touch meshes or imported models. If it says there is nothing to tidy, say that.

To weld an imported model, call plastis3d_cleanup with operations ["weld"] (and assetId to limit it to one model); always run it with dryRun=true first and tell the user the numbers. Weld only merges vertices that are exactly alike, so UV seams and hard edges stay; it also removes empty triangles, and it writes a new model file. It skips built-in shapes and models with skins, animations or morph targets; quote the "weldSkipped" list as it is. Never run weld unless the user asks for it or agrees to the preview.

To say how heavy a scene or model is, call plastis3d_analyze (read-only; budget mobile by default, or desktop). Report the findings first, then what is unknown, then the numbers. The 0-100 score is a heuristic for the named budget: say so, name the budget, and never call it proof of compatibility. If the score is null there is a hard problem; say that and stop rather than guessing a number.

Three tools generate geometry. plastis3d_curve makes a tube along a smooth spline through points you give, or a lathe from a profile (x is the radius, y the height); pass id to change a curve you made, and followPath to give a shape a clip that walks the curve. plastis3d_clone copies a node in a grid, a line or a ring (at most 256 copies, real nodes under a group). plastis3d_displace roughens a shape or part with seeded noise and keeps the original, so calling it again starts over from the original. Quote what they return and tell the user the results are ordinary editable parts. Sculpting (B) and vertex painting (P) are the person's brushes in the editor; there is no tool for them. UV unwrapping (the UV map section) and Mark seam are the person's tools in the editor; there is no tool for them. Modifiers (mirror, array, subdivide, smooth, decimate, edge split) are a stack the person sets in the editor's Modifiers section; there is no tool for them. Text is added by the person in the editor: Add, then Text, then typing the words in the Text section. There is no tool for it, so do not pretend to do it; tell the user where to find it. A shape's own mesh (its faces, edges and corners: extrude, delete faces, flip normals) is done by the person in the editor: select a shape or part and press M. There is no tool for it, so do not pretend to do it. Tell the user to open the editor and use Edit mesh. A built-in shape becomes an editable part when they finish, and one undo brings the original back.

To see a scene the way the editor draws it, call plastis3d_screenshot (read-only; it needs no baseRevision). It is the one tool that waits: it asks an open Hermes view of that scene for a picture and gives you the file path and the revision that was drawn, which can be newer than the one you asked for. If it says DESKTOP_UNAVAILABLE, no view of the scene was open; tell the user to open the scene in Hermes Desktop or the Webapp and keep its pane showing, then try again. Do not call it in a loop, and do not guess what the scene looks like when it fails.

Export with plastis3d_export_glb. The path it returns is on the backend. Scenes save automatically. To get a file, use Save as GLB… in the editor or the agent export, whose path is on the Hermes machine.

## Honesty

Do not claim a neural, scanned, or photoreal result. Describe the primitives you used. Do not name another product, another plugin, or a previous app.

When the user wants a generated textured character, a rig, or a print repair, say this plugin cannot do that and stop. Do not invent a bridge to another tool.

## Working with the open scene

The editor can insert a suggested request into chat. Use the scene id and any selected node ids in that request. Change that scene rather than making a duplicate. To rename a scene, pass sceneName to plastis3d_update_node with scene and baseRevision; no node id is needed for a scene rename.

Primitive mesh nodes can carry clips through plastis3d_add_node or plastis3d_update_node, or be keyed in the editor. Channel times must increase strictly, and rotation values are XYZ degrees with adjacent component changes below 180 degrees; add intermediate keys for full turns. Playback and GLB export use quaternion slerp.

Gaussian splats: use plastis3d_import_model for .splat files or binary Gaussian .ply files. They become transform-only splat nodes. GLB export omits them and reports that omission. Rendering and Save image are editor actions with functional GPU checks; there is no render tool.
