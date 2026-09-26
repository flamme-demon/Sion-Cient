#!/usr/bin/env bash
# Parité des salons entre le moteur JS et le moteur Rust, sur un VRAI compte
# (T1, docs/plan-matrix-rust-sdk.md). Chaque moteur se connecte comme un
# appareil de passage, écrit sa liste, puis supprime son appareil.
#
#   SION_TEST_SERVEUR=sionchat.fr SION_TEST_IDENTIFIANT=… SION_TEST_MOT_DE_PASSE=… \
#     ./build-scripts/parite-salons.sh
#
# Code de sortie 1 si un champ strict diffère. `lastActivity` est seulement
# signalé : les deux moteurs ne voient pas exactement le même dernier événement.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SION_TEST_SERVEUR:?}" "${SION_TEST_IDENTIFIANT:?}" "${SION_TEST_MOT_DE_PASSE:?}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "▶ moteur JS"
SION_TEST_SORTIE_SALONS_JS="$tmp/js.json" bunx vitest run src/stores/pariteSalons.test.ts >/dev/null
echo "▶ moteur Rust"
(cd src-tauri && SION_TEST_SORTIE_SALONS="$tmp/rust.json" RUST_LOG=off \
  cargo test -q -j4 -p sion-matrix --test compte_reel -- --ignored >/dev/null)

python3 - "$tmp/js.json" "$tmp/rust.json" <<'PY'
import json, sys
js = {s["id"]: s for s in json.load(open(sys.argv[1]))}
rs = {s["id"]: s for s in json.load(open(sys.argv[2]))}
STRICTS = ["name", "topic", "icon", "hasVoice", "isDM", "dmUserId", "isSoundboard", "createdAt"]
def vocal(s):
    return sorted((u["id"], u.get("name"), u.get("muted"), u.get("deafened"), u.get("avatarUrl")) for u in s.get("voiceUsers", []))
ecarts = 0
for sid in sorted(set(js) | set(rs)):
    a, b = js.get(sid), rs.get(sid)
    if a is None or b is None:
        print(f"✗ {sid} : présent seulement côté {'Rust' if a is None else 'JS'}"); ecarts += 1; continue
    diff = [(c, a.get(c), b.get(c)) for c in STRICTS if a.get(c) != b.get(c)]
    if vocal(a) != vocal(b):
        diff.append(("voiceUsers", vocal(a), vocal(b)))
    marque = "✓" if not diff else "✗"
    print(f"{marque} {a['name']}")
    for champ, vjs, vrs in diff:
        print(f"    {champ}: JS={vjs!r}  Rust={vrs!r}")
    ecarts += len(diff)
    if a.get("lastActivity") != b.get("lastActivity"):
        print(f"    (info) lastActivity: JS={a.get('lastActivity')} Rust={b.get('lastActivity')}")
print(f"\n{len(js)} salons côté JS, {len(rs)} côté Rust — {ecarts} écart(s) sur les champs stricts")
sys.exit(1 if ecarts else 0)
PY
