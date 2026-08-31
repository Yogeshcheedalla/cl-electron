# Skills

A skill is a folder with a `skill.json` manifest and an optional `prompt.md`.
Enabled skills contribute their prompt text to the system prompt, and nothing
else — **Akansha never executes code from a skill folder**. No file here is
`require`d, imported or evaluated.

```
skills/
  morning-briefing/
    skill.json     # name, version, description, tools[]
    prompt.md      # instructions appended to the system prompt when enabled
```

`skill.json` fields:

| Field | Meaning |
| --- | --- |
| `name` | Required. Unique; used as the enable/disable key. |
| `version` | Shown in the UI and in the prompt fragment. |
| `description` | One line, shown on the Settings page. |
| `tools` | Names of **existing** Akansha tools the skill expects. Unknown names are dropped with a warning. |
| `prompt` | Optional inline alternative to `prompt.md`. |

Listing a tool grants nothing. Every call still goes through the permission
layer, so a skill that asks for `file.remove` still triggers a confirmation
prompt, and a tool set to BLOCKED stays blocked.

Two locations are searched, user data first so it wins on a name clash:

1. `%APPDATA%\Akansha\skills\` — where you drop your own
2. the bundled `skills\` folder next to the app

Skills are read when the list is requested, so adding a folder and reopening
Settings → Skills picks it up without a restart. Disabling is remembered in
`%APPDATA%\Akansha\skills.json`.
