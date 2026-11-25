# Jeeves

Jeeves is a macOS desktop assistant with a 3D head that speaks. You hold a key and talk. Jeeves sends your words to a coding agent in a project folder, and the head speaks a short summary of the reply. The full reply is in the log.

## Features

- Push-to-talk speech to text, and text to speech with lip-sync. Both use ElevenLabs.
- A Claude Code session through the Claude Agent SDK, or a direct Anthropic API session.
- Permission and question cards. You can answer them by voice or with a button.
- A list of recent projects. Jeeves can also show your Claude Code projects. You can change the project by voice, for example "open the project jeeves".
- A log view with Markdown, copy buttons, the cost, and an optional cost limit.
- A notification and a Dock bounce when the agent needs you.
- A transparent window that stays on top, with face presets and installable face packages.

## Requirements

| Item | Version | Note |
| --- | --- | --- |
| macOS | | Jeeves uses the Keychain and `osascript`. Other systems are not supported now. |
| Node.js | 22.12 or later | For the web view and the build tools. |
| Rust | stable | For the Tauri shell. |
| Bun | 1.x | Compiles the brain to 1 binary. |
| ElevenLabs API key | | For speech to text and text to speech. |
| Claude Code CLI, logged in | | For the Claude Code provider. |
| Anthropic API key | | Only for the Anthropic API provider. |

## Set up

1. Install the dependencies:

   ```sh
   npm install
   npm --prefix sidecar install
   ```

2. Put your ElevenLabs key in the Keychain:

   ```sh
   security add-generic-password -s jeeves -a elevenlabs -w
   ```

3. If you use the Anthropic API provider, put your Anthropic key in the Keychain:

   ```sh
   security add-generic-password -s jeeves -a anthropic -w
   ```

4. Start the app:

   ```sh
   npm run tauri dev
   ```

The command `security ... -w` with no value asks for the key, so the key does not go into your shell history. Jeeves also reads `ELEVENLABS_API_KEY` and `ANTHROPIC_API_KEY` from the environment. A Keychain entry has priority over an environment variable.

To make an app bundle, run `npm run tauri build`.

## Use

Click the Jeeves window to give it the keyboard focus. Then use these keys:

| Key | Action |
| --- | --- |
| Space (hold) | Talk. Wait until the head shows "listening", then speak. Release the key when you stop. |
| Escape | Stop the speech and interrupt the agent. Closes an open view. |
| S | Show or hide the panel with the text field and the project. |
| L | Show or hide the log. |
| , | Open the settings. |
| F | Change the face. |
| T | Always show the transcript, or hide it after a time. |

Say "stop" to interrupt the agent. Say "yes" or "no" to answer a permission card.

## Face packages

You can add faces from face packages: `.glb` files with a 3D model and a manifest. A package holds no code. You can install a package from a file, from an HTTPS URL, or from a face catalog with an optional ed25519 signature. Jeeves records the source and the hash of each package. Read [docs/face-packages.md](docs/face-packages.md) for the format and for how to make a catalog.

## How it works

Jeeves has 3 parts:

| Part | Folder | Task |
| --- | --- | --- |
| Shell | `src-tauri/` | The Tauri app in Rust. It reads the keys from the Keychain, starts the brain, and restarts it after a crash. |
| Web view | `web/` | The head (Three.js), the microphone, the speech player, and the panels. |
| Brain | `sidecar/` | A TypeScript process, compiled with Bun. It calls ElevenLabs and runs the agent session. |

The web view and the brain send JSON lines to each other through the shell. The message types are in `sidecar/src/protocol.ts`.

## Privacy

- **Audio.** Your recording goes to ElevenLabs for speech to text. Jeeves keeps only the last recording, in `$TMPDIR/jeeves-last-recording.wav`.
- **Text.** The spoken reply goes to ElevenLabs for text to speech. Your requests go to Anthropic, through Claude Code or the API.
- **Local files.** The settings are in `~/Library/Application Support/app.jeeves.desktop/brain-settings.json`. If "Show my Claude Code projects" is on, Jeeves reads `~/.claude.json` to list your projects. Jeeves never writes to that file.

## Security

The agent works in the project folder that you select. It can read, find and search files in that folder with no question. For a read outside the folder and for each other tool, Jeeves shows a permission card first. Read [SECURITY.md](SECURITY.md) before you use Jeeves on a folder with secrets.

## Development

```sh
npm test              # unit tests for the web view and the brain
npx tsc --noEmit      # type check of the web view
cd src-tauri && cargo check
```

The brain binary is built again each time you start `npm run tauri dev`.

## License

MIT. Read [LICENSE](LICENSE).
