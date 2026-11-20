# Plain env values

Status: accepted 2026-11-12.

## Behavior

- A line in `workers/<project>/env.txt` (or `workers/_all/env.txt`) is a name, optionally followed by the word `plain`: `MQTT_HOST plain`. A name without the word stays a secret, as before.
- A plain value is not a secret. It is for values like hosts, ports and feature flags.
- Settings → Env lists every name in one table: name, the projects that use it, its state (Set or Missing), and its value field.
  - A secret row never shows its value. A set secret shows Replace, which opens an empty password field.
  - A plain row shows its value in a text field after save, and the field stays editable.
- The board stores plain values in the config row as plain text (`envPlain`), apart from the sealed secrets (`envValues`).
- A plain value is not redacted from logs. Secret values stay redacted as before.
- A turn receives every listed name that has a value, plain or secret, as an environment variable. Missing names still go into the card log, as before.
- A turn whose listed names have values also gets `OTTR_CARD_ENV_NOTE`. Its value tells the agent that eval cells cannot read the listed names (omp filters the eval kernel env) and that a value must come from a script run through bash. A bash child inherits the full turn env, so a script run through bash reaches every listed value.

## Boundaries and errors

- One name has one kind. When any listing of the name lacks `plain`, the name is a secret: a secret listing wins, so a typo never exposes a secret.
- A line with any other second word, or more than two words, is an error for that file, like a bad name today.
- POST `/api/settings/env` stores a plain value without the secret box, so a board with no box can save it. A secret value still needs the box.
- When a name has both a stored secret and a stored plain value (the kind changed), the turn gets the value of the current kind.
- An empty value is still refused for both kinds.

## Acceptance checks

- `parseEnvTxt("MQTT_HOST plain\nTOKEN\n")` returns both names with their kinds. `"A b"` throws.
- `listedEnvNames` marks a name plain only when every listing says `plain`.
- GET `/api/settings/env` returns `plain` for each row and `value` for a set plain row, never for a secret row.
- POST of a plain name stores it in `envPlain`, and the value is not in the redaction list.
- A turn of a project that lists a plain name gets it in its env.
- A turn whose env.txt lists a name with a value gets `OTTR_CARD_ENV_NOTE` in its env; a project that lists no name gets none. A bash child of the turn reads the listed name's value.

## Non-goals

- No values in the data repo.
- No per-name switch in Settings: the kind comes from env.txt only.
- No delete of a stored value (parity with secrets).
