# Voice channel cue sounds

Drop royalty-free sound files here to replace the synthesized fallback used by
the voice-channel join/leave/timeout cues (see
`src/services/voiceChannelSounds.ts`).

## Naming (auto-detected, any of `.ogg` / `.mp3` / `.wav` / `.m4a`)

| File      | Plays when…                                              |
|-----------|----------------------------------------------------------|
| `join`    | a member joins the voice channel you're in               |
| `leave`   | a member leaves cleanly                                  |
| `timeout` | a member drops (connection lost / timeout)               |

e.g. `join.ogg`, `leave.ogg`, `timeout.ogg`. Keep them short (< 1 s) and
already volume-normalized. Prefer `.ogg` (small, Chromium plays it natively in
CEF without proprietary codecs).

## Where to find CC0 / royalty-free sounds (no attribution needed)

- **Pixabay** — https://pixabay.com/sound-effects/ (search "join", "pop",
  "notification", "logout"). License: royalty-free, no attribution.
- **Kenney** — https://kenney.nl/assets/interface-sounds and
  https://kenney.nl/assets/digital-audio (CC0). Great clean UI blips/pops.
- **Mixkit** — https://mixkit.co/free-sound-effects/ (free, royalty-free).
- **Freesound** — https://freesound.org/ — filter the license facet to
  **Creative Commons 0** to avoid attribution.
- **OpenGameArt** — https://opengameart.org/ (filter CC0).

Suggested vibe: a soft "pop"/"swoosh up" for join, a "swoosh down"/"pop low"
for leave, and a lower "error"/"disconnect" tone for timeout.

The toggle lives in Settings → (Audio/Notifications) "Sons du salon vocal".
