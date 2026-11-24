# Face packages

A face package adds a face to Jeeves. It is 1 binary glTF 2.0 file with the extension `.glb`. It holds only data: a 3D model, an optional paint texture and a manifest. It holds no code. Thus a package from an unknown source cannot send messages to the Jeeves brain.

## Install and remove

1. Open the settings (key `,`).
2. In the Character section, click **Install face** and select the `.glb` file.
3. To remove a package face, select it in the face list and click **Remove**.

Jeeves keeps the packages in `~/Library/Application Support/app.jeeves.desktop/faces/<id>.glb`. A new package with the same id replaces the old one. A package face shows "(package)" after its name in the face list.

If a package cannot load, the settings show a note, and the log (key `L`) gives the cause.

## Manifest

The manifest is in the glTF JSON, at `asset.extras.jeevesFace`. The checks are in `web/scene/facePackage.ts`.

| Field | Type | Rule |
| --- | --- | --- |
| `format` | text | Must be `jeeves-face/1`. |
| `id` | text | 1 to 40 characters: lowercase letters, digits and `-`, not `-` first. It is also the file name. |
| `name` | text | The name in the face list. |
| `version` | text | The package version, for example `1.2.0`. |
| `author` | text | The author of the face. |
| `license` | text | The license of the face. |
| `description` | text | Optional. Up to 1000 characters. |
| `look.colors` | object | `base`, `highlight`, `accent` and `sweep`, each as `#rrggbb`. The head shades from `base` to `highlight`. `accent` is the rim color. `sweep` is the color of the "thinking" band. |
| `look.eyes` | object | The eye style. Read the next table. |
| `look.cap` | object | Optional. A mushroom cap above the height `y`: the colors `base`, `highlight` and `spots`, and the numbers `spotSize` and `y`. |
| `look.smooth` | number | Optional, 0 to 1. 0 shows flat facets. 1 shows a smooth surface. The default is 0. |
| `look.mouthShade` | number | Optional, 0 to 1. How dark the closed mouth is. The default is 0.55. |

### Eyes

Jeeves makes the eyes itself, so that they can blink and look around.

| Field | Rule |
| --- | --- |
| `length`, `height` | Half the size of the bright core. |
| `tilt` | The turn of the outer end, in radians. |
| `core`, `glow` | Colors as `#rrggbb`. |
| `glowStrength`, `glowWidth`, `glowHeight` | The strength and the size of the glow. |
| `white` | Optional. A cartoon eye white behind the core: `color`, `length` and `height`. |
| `pupil` | Optional. The place of the core in the white: `inward` (toward the nose) and `down`, as parts of the white size. The default is 0.22 and 0.15. |
| `whiteFlat` | Optional, 0 to 2. A scale for the lower half of the white. |

All numbers must be from -10 to 10, unless the table gives a different range.

## Model

The head is about 2 units high, with the center at the origin. +y is up, and +z points out of the face.

| Node | Content |
| --- | --- |
| `head` | The head mesh. The node transform is applied. |
| `eye_0`, `eye_1` | The place and the turn of the left and the right eye. Use `_`, not `.`: the GLTF loader removes `.` from node names. |

### Head mesh attributes

| glTF attribute | Content |
| --- | --- |
| `POSITION` | Required. At most 400,000 vertices. |
| `_AJAW` | Optional. 1 moves the vertex with the jaw. The jaw turns around the point (0, -0.1, -0.25). |
| `_AMOUTH` | Optional. A positive value darkens the inside of the mouth. A negative value selects a part color: -1 white, -2 dark, -3 brown, and -4 green. Vertices with -3 or -4 also move in a slow step, for example feet. |
| `_ALIP` | Optional. 1 moves the vertex with the lip shapes. |
| `_ABROW` | Optional. 1 moves the vertex with the brows. |
| `TEXCOORD_0` | Optional. Needed for the paint. |

A missing weight is 0, so that part does not move. Jeeves computes the normals itself. The Three.js `GLTFExporter` writes a geometry attribute `aJaw` as `_AJAW`, so you can use the same names as `web/scene/headMesh.ts`.

### Paint

The paint is the base color texture of the head material. Each texel gives the color at full light, and the alpha gives the coverage over the head colors. Jeeves shades the paint from 55 % in the dark to 100 % in full light. Paint also covers the mouth shade, for example for painted teeth. Paint shows only where `_AMOUTH` is -0.2 or more.

Jeeves samples the texture with no color conversion and does not flip it: the first image row is texture v = 0.

## Limits

- The largest package is 20 MB.
- The head mesh can have at most 400,000 vertices.
- All data must be in the file. Jeeves refuses a package with a `uri` in `buffers` or `images`.
- Jeeves checks the size, the GLB header and the id before it copies a file. It checks the full manifest when it loads the package.
