#!/bin/bash
# Sion Client — Diagnostic de démarrage Linux (fenêtre blanche / page qui ne
# s'affiche pas). Script à lancer par la personne qui a le problème.
#
# Usage :
#   ./diagnose-linux.sh /chemin/vers/Sion_Client-2.0.0-alpha.2-x86_64.AppImage
#
# Options :
#   --fast        saute le cas « rendu logiciel » (LIBGL_ALWAYS_SOFTWARE=1)
#   --timeout N   durée de chaque essai en secondes (défaut : 25)
#
# Le script relance l'AppImage plusieurs fois, chacune avec une variable
# d'environnement qui contourne une cause connue de page blanche sous
# WebKitGTK. Pour chaque essai il capture la sortie terminal ET le journal de
# l'appli, puis emballe le tout dans une archive à renvoyer.
#
# À la fin : si un essai affiche l'interface, le script donne la ligne exacte
# à utiliser pour lancer Sion en permanence.

set -u

APPIMAGE="${1:-}"
shift || true
FAST=0
TIMEOUT=25
while [ $# -gt 0 ]; do
    case "$1" in
        --fast) FAST=1 ;;
        --timeout) TIMEOUT="${2:-25}"; shift ;;
        *) echo "Option inconnue : $1" >&2; exit 2 ;;
    esac
    shift
done

if [ -z "$APPIMAGE" ] || [ ! -f "$APPIMAGE" ]; then
    echo "Usage : $0 <chemin/AppImage> [--fast] [--timeout N]"
    exit 2
fi
[ -x "$APPIMAGE" ] || chmod +x "$APPIMAGE" 2>/dev/null || true

# Journal de l'appli (target « LogDir » du plugin de log Tauri).
APPLOG_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/com.sion.client/logs"
APPLOG="$APPLOG_DIR/Sion Client.log"

REPORT_DIR="$HOME/sion-diagnostic-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$REPORT_DIR/runs" "$REPORT_DIR/logs"

if [ -z "${SION_DIAG_ALLOW_SECOND:-}" ] && pgrep -f "usr/bin/sion-client" >/dev/null 2>&1; then
    echo "⚠ Sion tourne déjà. Ferme-le d'abord puis relance ce script"
    echo "  (sinon deux instances se partagent raccourcis et journal)."
    echo "  Pour passer outre : SION_DIAG_ALLOW_SECOND=1 $0 …"
    exit 1
fi

echo "→ Essai préalable : montage FUSE de l'AppImage…"
if [ -n "$(timeout 3 "$APPIMAGE" --appimage-mount 2>/dev/null | head -1)" ]; then
    FUSE_OK=1
    echo "  montage OK"
else
    FUSE_OK=0
    echo "  ⚠ le montage de l'AppImage n'a rien renvoyé — fuse2 manquant ?"
    echo "    Les essais passent en mode « extraction directe » (APPIMAGE_EXTRACT_AND_RUN=1)."
fi
echo

# ── 1. Environnement ────────────────────────────────────────────────────────
{
    echo "=== Date : $(date -Is)"
    echo "=== AppImage : $APPIMAGE"
    echo "=== md5 : $(md5sum "$APPIMAGE" | cut -d' ' -f1)"
    echo "=== Montage FUSE : $FUSE_OK"
    echo
    echo "--- Système ---"
    grep -E '^(NAME|VERSION|ID)=' /etc/os-release
    uname -r
    echo
    echo "--- Session ---"
    echo "XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-?}"
    echo "XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-?}"
    echo "DISPLAY=${DISPLAY:-?}  WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-?}"
    echo
    echo "--- GPU / pilotes ---"
    (lspci -nnk 2>/dev/null | grep -A3 -Ei 'vga|3d|display') || echo "lspci indisponible"
    if command -v glxinfo >/dev/null; then glxinfo -B 2>&1 | head -20; else echo "(glxinfo absent)"; fi
    echo
    echo "--- Paquets WebKit / sandbox / GStreamer / fuse ---"
    for p in webkit2gtk-4.1 webkitgtk-6.0 bubblewrap gst-libav gst-plugins-good fuse2; do
        pacman -Q "$p" 2>&1
    done
    echo
    echo "--- Bibliothèques WebKit vues par l'éditeur de liens ---"
    ldconfig -p 2>/dev/null | grep -E 'libwebkit2gtk|libgtk-3' || echo "(aucune)"
    echo
    echo "--- Journal de l'appli avant essais ---"
    ls -la "$APPLOG" 2>&1
} > "$REPORT_DIR/environnement.txt" 2>&1
echo "Environnement capturé → $REPORT_DIR/environnement.txt"

# ── 2. Essais ───────────────────────────────────────────────────────────────
CASE_NAMES=("01-baseline" "02-sans-dmabuf" "03-sans-compositing" "04-wayland-natif")
CASE_ENVS=("G_MESSAGES_DEBUG=all" "WEBKIT_DISABLE_DMABUF_RENDERER=1" \
           "WEBKIT_DISABLE_COMPOSITING_MODE=1" "SION_KEEP_WAYLAND=1")
if [ "$FAST" -eq 0 ]; then
    CASE_NAMES+=("05-rendu-logiciel")
    CASE_ENVS+=("LIBGL_ALWAYS_SOFTWARE=1")
fi

[ "$FUSE_OK" -eq 0 ] && CASE_ENVS=("${CASE_ENVS[@]/#/APPIMAGE_EXTRACT_AND_RUN=1 }")

SUMMARY="$REPORT_DIR/resume.txt"
: > "$SUMMARY"
WINNER=""

log_size() { stat -c%s "$APPLOG" 2>/dev/null || echo 0; }

for i in "${!CASE_NAMES[@]}"; do
    name="${CASE_NAMES[$i]}"
    envs="${CASE_ENVS[$i]}"
    out="$REPORT_DIR/runs/$name.out"

    echo "──────────────────────────────────────────────"
    echo "Essai $name :  $envs"
    echo "──────────────────────────────────────────────"

    size_before=$(log_size)
    # shellcheck disable=SC2086
    env $envs timeout "$TIMEOUT" "$APPIMAGE" > "$out" 2>&1
    rc=$?
    [ "$rc" = 0 ] || [ "$rc" = 124 ] || [ "$rc" = 143 ] || echo "  (code de sortie : $rc)"

    # Journal de l'appli produit pendant cet essai.
    tail -c "+$((size_before + 1))" "$APPLOG" > "$REPORT_DIR/logs/$name.log" 2>/dev/null || true

    # Marqueurs objectifs : le Rust a démarré, et le front (JS) s'est connecté.
    backend=non ; frontend=non
    grep -q "Shortcut WebSocket server" "$out" "$REPORT_DIR/logs/$name.log" 2>/dev/null && backend=oui
    grep -q "WS shortcut client connected" "$out" "$REPORT_DIR/logs/$name.log" 2>/dev/null && frontend=oui
    echo "  backend (Rust) démarré : $backend — front (JS) chargé : $frontend"
    if [ "$backend" = non ] && [ "$(wc -c < "$out")" -eq 0 ]; then
        echo "  ⚠ aucune sortie du tout : l'AppImage n'a même pas démarré (FUSE ?)."
    fi

    ok=0
    if [ -t 0 ]; then
        read -r -p "  L'interface Sion s'affiche-t-elle (et non une fenêtre blanche) ? [o/n/q] " ans
        case "$ans" in
            [oO]*) ok=1 ;;
            [qQ]*) echo "Arrêt demandé."; break ;;
        esac
        if [ "$ok" = 1 ]; then
            echo "$name : AFFICHÉ  ($envs)" >> "$SUMMARY"
            WINNER="$envs"
            break
        fi
        echo "$name : pas d'affichage  ($envs) [backend=$backend front=$frontend]" >> "$SUMMARY"
    else
        echo "$name : à vérifier à l'œil  ($envs) [backend=$backend front=$frontend]" >> "$SUMMARY"
    fi
done

# ── 3. Conclusion ───────────────────────────────────────────────────────────
{
    echo "=== Résumé ==="
    cat "$SUMMARY"
    echo
    if [ -n "$WINNER" ]; then
        echo "Lancement qui fonctionne :"
        echo "  $WINNER \"$APPIMAGE\""
        echo "Note-le : on en fera un lanceur permanent."
    else
        echo "Aucun essai n'a affiché l'interface."
        echo "À regarder en premier : runs/01-baseline.out (messages WebKit/GTK)"
        echo "puis logs/01-baseline.log (côté appli)."
        echo "Si 05-rendu-logiciel affiche alors que les autres non → chemin GPU."
    fi
} > "$REPORT_DIR/conclusion.txt"
cat "$REPORT_DIR/conclusion.txt"

ARCHIVE="$REPORT_DIR.tar.gz"
tar czf "$ARCHIVE" -C "$(dirname "$REPORT_DIR")" "$(basename "$REPORT_DIR")"
echo
echo "Archive à renvoyer : $ARCHIVE"
