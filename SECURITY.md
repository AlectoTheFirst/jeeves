# Security

## Report a vulnerability

Do not open a public issue for a vulnerability. Use the private report function of GitHub: open the Security tab of this repository and click "Report a vulnerability". Give the steps to reproduce the problem and the version or commit that you used.

## What the agent can do

Jeeves runs a coding agent on your computer, with the permissions of your user account. Know these limits before you use it:

- **Read access.** The tools Read, Glob and Grep are approved automatically only inside the project folder. Jeeves resolves symlinks before it does the check. A read outside the project folder, for example of `~/.ssh`, shows a permission card.
- **Shell commands.** A Bash command can read any file that your user account can read, for example with `cat`. Each Bash command shows a permission card first.
- **Other tools.** For each other tool, for example Bash, Write or a web request, Jeeves shows a permission card. Read the command on the card before you say "yes".
- **Trusted MCP tools.** If you mark an MCP server as trusted in the settings, its tools are approved automatically.
- **Claude Code settings.** With the Claude Code provider, allow rules in your Claude Code settings files can also approve tools automatically. Jeeves does not show these rules.
- **Prompt injection.** A file, a web page or a tool result can contain text that tells the agent to do something. Thus a permission card can ask for an action that you did not request. Say "no" if you do not know why the agent wants to do it.

## Keys

Jeeves reads the API keys from the macOS Keychain, service `jeeves`. Only the Rust shell reads the Keychain. It gives the keys to the brain process as environment variables. The web view never gets the keys.

## Web view

The web view has a strict Content Security Policy. It loads scripts only from the app and from a `blob:` URL for the audio worklet. It does not load content from the internet.
