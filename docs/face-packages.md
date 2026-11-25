# Face packages

A face package adds a face to Jeeves. It is 1 binary glTF 2.0 file with the extension `.glb`. It holds only data: a 3D model, an optional paint texture and a manifest. It holds no code. Thus a package from an unknown source cannot send messages to the Jeeves brain.

## Install and remove

Open the settings with the key `,`. You can install a package in 3 ways:

- **From a file**: in the Character section, click **Install face** and select the `.glb` file.
- **From a URL**: in the Face packages section, type the HTTPS URL in **Package URL** and click **Install**. If you type the SHA-256 of the file in **Package SHA-256**, Jeeves refuses a download with a different hash.
- **From a catalog**: type the catalog URL in **Catalog URL** and the catalog key in **Catalog key**, then click **Load catalog**. Each face has an **Install** button, or an **Update** button when the catalog has a different file for an installed face.

To remove a package face, select it in the face list and click **Remove**.

Jeeves keeps the packages in `~/Library/Application Support/app.jeeves.desktop/faces/<id>.glb`. A package face shows "(package)" after its name in the face list. Under the face list, the settings show the version, the author and the source of the selected package face.

If a package cannot load, the settings show a note, and the log (key `L`) gives the cause.

### Install record

The file `faces/installed.json` holds 1 record for each installed package: the source (`file`, `url` or `catalog`), the file path or the download URL, the catalog URL, the SHA-256 of the file, the install time, and the name, the version and the author from the manifest. Only the Rust shell writes this file.

A new package with the same id as an installed package replaces it at once if the author, the source and the catalog are the same. Jeeves asks before it replaces the package in these cases:

- The new package has a different author.
- The new package comes from a different source or a different catalog.
- The installed package has no record and the files are different.

The same file again changes nothing. The author is the text in the manifest. Jeeves does not check it. Only a signed catalog shows that the catalog author published the file.

A replace question applies only to the install that asked it. A new install cancels the question. If the installed package changes before you click **Replace**, Jeeves asks again.

### Downloads

The Rust shell does all downloads. The web view cannot connect to the network. A download must use HTTPS, also after a redirect. It can have at most 5 redirects, it stops after 60 s, and it stops at 20 MB. Jeeves then does the same checks as for a file.

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

## Catalog

A catalog is a folder on an HTTPS server with an `index.json` file, the `.glb` files, and an optional signature file `index.json.sig`.

### Index

```json
{
  "format": "jeeves-face-catalog/1",
  "faces": [
    {
      "id": "owl",
      "name": "Owl",
      "version": "1.0.0",
      "author": "Ann",
      "license": "CC-BY-4.0",
      "description": "A night owl.",
      "url": "owl.glb",
      "sha256": "<64 hex characters>",
      "size": 123456
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| `id` | The package id. Each id is used once. The package manifest must have the same id. |
| `url` | A file name next to `index.json`, a path under that folder with no `..`, or an absolute HTTPS URL. The catalog URL must have a path after the host. |
| `sha256` | The SHA-256 of the package file. Jeeves refuses a download with a different hash. |
| `size` | The size of the package file in bytes, at most 20 MB. Jeeves stops a download that is larger. |

The index can be at most 1 MB and can have at most 500 faces. When Jeeves installs a catalog face, the shell downloads and checks the index again, so the hash comes from the catalog and not from the web view.

### Signature

A catalog key is an ed25519 public key, as 64 hex characters. With a catalog key in the settings, Jeeves downloads `index.json.sig` and refuses the catalog if the signature of the exact bytes of `index.json` does not match the key. Without a key, the settings show the catalog as "not signed", and only HTTPS and the hashes in the index protect the files. A key that is not 64 hex characters stops the catalog.

`index.json.sig` holds the 64-byte signature as 128 hex characters.

### Make a catalog

`scripts/face-catalog.mjs` makes the key, the index and the signature. It needs only Node.

1. Run `node scripts/face-catalog.mjs keygen`. The script writes the private key to `~/.config/jeeves/catalog-sign.key` with mode 600 and shows the public key. To use a different file, set `JEEVES_CATALOG_KEY` to its path.
2. Put the `.glb` files in 1 folder.
3. Run `node scripts/face-catalog.mjs build <folder>`. The script writes `<folder>/index.json` and, if the key file is there, `<folder>/index.json.sig`. Without a key file, it deletes an old `index.json.sig`.
4. Copy the folder to the HTTPS server.
5. Give the users the URL of `index.json` and the public key. To show the public key again, run `node scripts/face-catalog.mjs pubkey`.

Keep the private key secret, and keep a backup of it. With a new key, each user must type the new public key.

