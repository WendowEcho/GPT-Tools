# GPT Tools — Project State

## Repository
- Owner: WendowEcho
- Repository: GPT-Tools
- Visibility: Public
- Version: 0.5.0

## Scope
- Microsoft Edge browser extension for ChatGPT.
- Focus on bounded rendering optimization for long conversations.
- No terminal execution, Native Messaging Host, or clipboard features.

## Repository Migration
- Extracted from BoZhangCS/Tools/gpt tools.
- Uses independent Git history.
- Original repository remains unchanged.
- SSH alias: github-gpttools.

## Maintenance
- Keep extension logic lightweight.
- Minimize DOM traversal and redundant observers.
- Reuse existing state and observers whenever possible.
- Validate changes before publishing.
