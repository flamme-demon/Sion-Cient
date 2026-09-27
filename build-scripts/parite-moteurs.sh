#!/usr/bin/env bash
# Parité entre le moteur JS et le moteur Rust, sur un VRAI compte
# (docs/plan-matrix-rust-sdk.md) : salons (T1) et messages de chaque salon
# (T2). Chaque moteur se connecte comme un appareil de passage, écrit ce qu'il
# produit, puis supprime son appareil.
#
#   SION_TEST_SERVEUR=sionchat.fr SION_TEST_IDENTIFIANT=… SION_TEST_MOT_DE_PASSE=… \
#     ./build-scripts/parite-moteurs.sh
#
# Code de sortie 1 si un champ strict diffère, ou si un message manque d'un
# côté alors qu'il est dans la fenêtre chargée par l'autre. Seulement
# signalés : la dernière activité d'un salon, et les écarts VOULUS du moteur
# Rust (sion-matrix/src/messages.rs) — URL des médias (servis par
# sion-media://), miniature d'une image chiffrée, heure affichée (calculée
# par l'interface), clés de chiffrement (jamais exposées), éditions de médias
# que le JS affichait en double, marque « modifié » d'un média édité.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SION_TEST_SERVEUR:?}" "${SION_TEST_IDENTIFIANT:?}" "${SION_TEST_MOT_DE_PASSE:?}"
# SION_PARITE_SORTIES=<dossier> garde les sorties des deux moteurs pour
# examiner un écart.
if [[ -n "${SION_PARITE_SORTIES:-}" ]]; then
  tmp=$SION_PARITE_SORTIES; mkdir -p "$tmp"
else
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
fi

echo "▶ moteur JS"
SION_TEST_SORTIE_SALONS_JS="$tmp/js.json" SION_TEST_SORTIE_MESSAGES_JS="$tmp/js-messages.json" \
  SION_TEST_SORTIE_DETAILS_JS="$tmp/js-details.json" SION_TEST_SORTIE_SONS_JS="$tmp/js-sons.json" \
  bunx vitest run src/stores/pariteSalons.test.ts >/dev/null
echo "▶ moteur Rust"
(cd src-tauri && SION_TEST_SORTIE_SALONS="$tmp/rust.json" SION_TEST_SORTIE_MESSAGES="$tmp/rust-messages.json" \
  SION_TEST_SORTIE_DETAILS="$tmp/rust-details.json" SION_TEST_SORTIE_SONS="$tmp/rust-sons.json" RUST_LOG=off \
  cargo test -q -j4 -p sion-matrix --test compte_reel -- --ignored >/dev/null)

python3 - "$tmp/js.json" "$tmp/rust.json" "$tmp/js-messages.json" "$tmp/rust-messages.json" "$tmp/js-details.json" "$tmp/rust-details.json" "$tmp/js-sons.json" "$tmp/rust-sons.json" <<'PY'
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

# ── Messages (T2) ─────────────────────────────────────────────────────────────
print("\n── Messages")
noms = {sid: s["name"] for sid, s in js.items()}
sorties_js = json.load(open(sys.argv[3]))
fjs = {f["salon"]: f["messages"] for f in sorties_js}
editions_js = {f["salon"]: set(f.get("editions") or []) for f in sorties_js}
epingles_js = {f["salon"]: f.get("epingles") or [] for f in sorties_js}
epingles_rs = {f["salon"]: f.get("epingles") or [] for f in json.load(open(sys.argv[4]))}
frs = {f["salon"]: f["messages"] for f in json.load(open(sys.argv[4]))}
MSTRICTS = ["senderId", "user", "role", "avatarUrl", "ts", "text", "formattedBody", "msgtype", "edited", "replyTo", "poll"]
def reactions(m):
    return sorted((r["emoji"], r["count"], tuple(sorted(r["userIds"])), tuple(sorted(r["eventIds"].items()))) for r in m.get("reactions") or [])
def pieces(m):
    return [(p.get("name"), p.get("size"), p.get("mimeType"), p.get("width"), p.get("height"), bool(p.get("url"))) for p in m.get("attachments") or []]
necarts, nmessages, infos = 0, 0, 0
for sid in sorted(set(fjs) | set(frs)):
    a, b = fjs.get(sid, []), frs.get(sid, [])
    ids_a, ids_b = [m["eventId"] for m in a], [m["eventId"] for m in b]
    ecarts_salon = []
    communs_a = [i for i in ids_a if i in ids_b]
    communs_b = [i for i in ids_b if i in ids_a]
    if communs_a != communs_b:
        ecarts_salon.append("ordre des messages communs différent")
    # Les fenêtres peuvent différer : chaque moteur pagine à sa façon. Mais un
    # message plus récent que le plus ancien affiché par l'autre moteur est
    # dans SA fenêtre : il doit y figurer.
    a_par_id = {m["eventId"]: m for m in a}
    b_par_id = {m["eventId"]: m for m in b}
    doublons = [i for i in ids_a if i not in b_par_id and i in editions_js.get(sid, ())]
    if doublons:
        print(f"    (voulu) {len(doublons)} édition(s) affichée(s) en double par le JS, ignorée(s) par Rust")
        infos += 1
    for manquant, present, cote in ((a_par_id, b_par_id, "Rust"), (b_par_id, a_par_id, "JS")):
        if not present:
            continue
        plus_ancien = min(m["ts"] for m in present.values())
        hors = [i for i, m in manquant.items() if i not in present and i not in doublons and m["ts"] > plus_ancien]
        for i in hors:
            ecarts_salon.append(f"{i} absent côté {cote} (dans sa fenêtre)")
        autres = sum(1 for i in manquant if i not in present and i not in doublons) - len(hors)
        if autres:
            print(f"    (info) {autres} message(s) hors de la fenêtre côté {cote}")
            infos += 1
    rb = {m["eventId"]: m for m in b}
    for m in a:
        n = rb.get(m["eventId"])
        if n is None:
            continue
        nmessages += 1
        for c in MSTRICTS:
            if c == "edited" and m.get(c) is None and n.get(c) and n.get("attachments"):
                print(f"    (voulu) {m['eventId']} média édité marqué « modifié » côté Rust")
                infos += 1
                continue
            if m.get(c) != n.get(c):
                ecarts_salon.append(f"{m['eventId']} {c}: JS={m.get(c)!r} Rust={n.get(c)!r}")
        if reactions(m) != reactions(n):
            ecarts_salon.append(f"{m['eventId']} reactions: JS={reactions(m)} Rust={reactions(n)}")
        if pieces(m) != pieces(n):
            ecarts_salon.append(f"{m['eventId']} attachments: JS={pieces(m)} Rust={pieces(n)}")
        for pa, pb in zip(m.get("attachments") or [], n.get("attachments") or []):
            if bool(pa.get("thumbnailUrl")) != bool(pb.get("thumbnailUrl")):
                print(f"    (info) {m['eventId']} miniature — JS : {bool(pa.get('thumbnailUrl'))}, Rust : {bool(pb.get('thumbnailUrl'))}")
                infos += 1
    if epingles_js.get(sid, []) != epingles_rs.get(sid, []):
        ecarts_salon.append(f"épinglés: JS={epingles_js.get(sid)} Rust={epingles_rs.get(sid)}")
    marque = "✓" if not ecarts_salon else "✗"
    nb_epingles = len(epingles_rs.get(sid, []))
    print(f"{marque} {noms.get(sid, sid)} — {len(a)} messages JS, {len(b)} Rust" + (f", {nb_epingles} épinglé(s)" if nb_epingles else ""))
    for e in ecarts_salon[:12]:
        print(f"    {e}")
    necarts += len(ecarts_salon)
print(f"\n{nmessages} messages comparés — {necarts} écart(s) strict(s), {infos} écart(s) voulu(s) signalé(s)")

# ── Membres et niveaux (T4) ───────────────────────────────────────────────────
print("\n── Membres et niveaux")
djs = {d["salon"]: d for d in json.load(open(sys.argv[5]))}
drs = {d["salon"]: d["details"] for d in json.load(open(sys.argv[6]))}
decarts = 0
for sid in sorted(set(djs) | set(drs)):
    a, b = djs.get(sid), drs.get(sid)
    if a is None or b is None:
        print(f"✗ {noms.get(sid, sid)} : détails d'un seul côté"); decarts += 1; continue
    # Infini (créateur d'un salon v12) : `Infinity` → null en JSON côté JS,
    # i64::MAX côté Rust.
    inf = lambda v: "∞" if v is None or (isinstance(v, int) and v >= 2**53) else v
    for m in a["membres"]:
        m["powerLevel"] = inf(m.get("powerLevel"))
    for m in b["membres"]:
        m["powerLevel"] = inf(m.get("powerLevel"))
    a["moi"], b["moi"] = inf(a.get("moi")), inf(b.get("moi"))
    diff = [f"{c}: JS={a.get(c)!r} Rust={b.get(c)!r}" for c in ["moi", "niveauEtat", "niveauInvitation", "peutEcrire", "regleAcces"] if a.get(c) != b.get(c)]
    ma = {m["userId"]: m for m in a["membres"]}
    mb = {m["userId"]: m for m in b["membres"]}
    if set(ma) != set(mb):
        diff.append(f"membres: JS seul={sorted(set(ma) - set(mb))} Rust seul={sorted(set(mb) - set(ma))}")
    for uid in sorted(set(ma) & set(mb)):
        for c in ["displayName", "powerLevel"]:
            if ma[uid].get(c) != mb[uid].get(c):
                diff.append(f"{uid} {c}: JS={ma[uid].get(c)!r} Rust={mb[uid].get(c)!r}")
        if ma[uid]["avatar"] != bool(mb[uid].get("avatarUrl")):
            diff.append(f"{uid} avatar: JS={ma[uid]['avatar']} Rust={bool(mb[uid].get('avatarUrl'))}")
    print(f"{'✓' if not diff else '✗'} {noms.get(sid, sid)} — {len(ma)} membres")
    for d in diff[:10]:
        print(f"    {d}")
    decarts += len(diff)
print(f"\n{len(djs)} salons — {decarts} écart(s) sur les membres et niveaux")

# ── Soundboard et memes (T6) ──────────────────────────────────────────────────
print("\n── Soundboard et memes")
sjs, srs = json.load(open(sys.argv[7])), json.load(open(sys.argv[8]))
secarts = 0
for genre, champs in (
    ("sons", ["mxcUrl", "label", "category", "emoji", "body", "mimetype", "size", "duration", "senderId", "timestamp", "gain", "refText", "avatarUrl", "kind", "ttsModel"]),
    ("memes", ["mxcUrl", "apercuMxc", "label", "emoji", "gain", "durationMs", "largeur", "hauteur", "senderId", "timestamp"]),
):
    a = [x["eventId"] for x in sjs[genre]]
    b = [x["eventId"] for x in srs[genre]]
    if a != b:
        print(f"✗ {genre} : ordre ou présence — JS seul={sorted(set(a) - set(b))} Rust seul={sorted(set(b) - set(a))}")
        secarts += 1
    pa = {x["eventId"]: x for x in sjs[genre]}
    pb = {x["eventId"]: x for x in srs[genre]}
    for i in sorted(set(pa) & set(pb)):
        for c in champs:
            va, vb = pa[i].get(c), pb[i].get(c)
            if isinstance(va, (int, float)) and isinstance(vb, (int, float)):
                egal = abs(va - vb) < 1e-9
            else:
                egal = va == vb
            if not egal:
                print(f"    {genre} {i} {c}: JS={va!r} Rust={vb!r}")
                secarts += 1
    print(f"{'✓' if secarts == 0 else '✗'} {len(a)} {genre} côté JS, {len(b)} côté Rust")
print(f"\n{secarts} écart(s) sur la soundboard et les memes")
sys.exit(1 if (ecarts or necarts or decarts or secarts) else 0)
PY
