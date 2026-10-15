# GPT Tools — Project State

## Release
- Version: 0.5.0
- Platform: Microsoft Edge
- Target: https://chatgpt.com/

## Features
- Bounded rendering for long conversations.
- Keeps historical conversation turns accessible.
- Configurable rendering window (1–10 turns; default 3).
- Toggle to enable or disable optimization.

## Maintenance
- Keep DOM observation incremental and reuse observers.
- Avoid repeated full-conversation scans.
- Package the `extension/` directory for each GitHub Release.
- Keep README focused on features and installation.
