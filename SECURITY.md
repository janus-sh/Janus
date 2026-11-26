# Security

## Reporting a problem

Report security problems privately: open the **Security** tab of this repository and choose **Report a vulnerability**. Please do not open a public issue for them.

A confirmed problem is fixed in the next release, and the changelog credits you unless you ask not to be named.

## What to know before you run Janus

- Janus runs commands and edits files on your machine, as you ask it to. Run it in folders you would trust it with.
- Your keys live in `~/.janus/agent/auth.json`, readable only by you. Each key is sent only to the service it belongs to.
- Free tiers may use what you send to improve their models. Keep secrets out of the folder you run Janus in.
- Paid keys in your shell are ignored unless you set `JANUS_ENV_KEYS=1`.

## Supported versions

Only the latest release gets fixes.
