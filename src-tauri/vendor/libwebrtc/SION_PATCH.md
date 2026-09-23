# Sion `libwebrtc` extension

Based on the published `libwebrtc` **0.3.46** crate used by LiveKit 0.8.4.
The original sources and notices are retained.

Sion adds `RtcAudioTrack::set_volume`, a safe forwarding method to the local
playback gain exposed by the vendored `webrtc-sys` bridge. It is used for the
volume slider of received screen-share audio. The accepted application range
is 0 to 1; WebRTC itself supports 0 to 10.

On an SDK update, remove this patch if upstream exposes the same operation. If
it remains necessary, verify the native and outer `RtcAudioTrack` wrappers and
run the native voice tests.

## Capture d'écran Wayland : contexte GLib privé

`src/native/desktop_capturer.rs` (`start`) : sous Wayland, la feature
`glib-main-loop` créait un `MainLoop` sur le **contexte GLib global**. Avec une
UI GTK/Tauri (WRY), ce contexte appartient à GTK : les réponses D-Bus du
portail ScreenCast (OpenPipeWireRemote) ne sont jamais dispatchées. Le
sélecteur d'écran s'affiche et la sélection aboutit, mais aucune frame
PipeWire n'arrive (erreurs temporaires en boucle, partage vide).

Le patch crée un `MainContext` privé, le pousse en thread-default le temps de
`Start` (c'est ce contexte que GDBus capture pour le proxy du portail), puis
l'itère sur son propre thread. Indépendant de GTK, donc fonctionnel quel que
soit le runtime de la fenêtre.

## SDP distant : normalisation `sprop-stereo` (collision BUNDLE)

`src/native/peer_connection.rs` (`set_remote_description`) : le SFU LiveKit
annonce parfois `sprop-stereo=1` sur une seule des m-lines opus (piste
stéréo), alors que les autres ne l'ont pas, tout en réutilisant le même
payload type (111). libwebrtc valide le BUNDLE (RFC 8843) et rejette la
description avec `A BUNDLE group contains a codec collision ...` /
`INVALID_PARAMETER` — observé à la connexion et à chaque renégociation
(début/arrêt de partage).

Le patch réécrit la description distante pour aligner **toutes** les m-lines
opus sur `sprop-stereo=1` avant de l'appliquer (`normalize_opus_sprop_stereo`),
puis la re-parse via `SessionDescription::parse`. Les réponses du client
conservent `stereo=1` ; les pistes mono ne sont pas affectées
(`sprop-stereo` n'est qu'une indication d'encodeur).

À retirer si le SFU cesse d'émettre des fmtp opus hétérogènes, ou si
libwebrtc/LiveKit normalise côté serveur.

## Statistiques : plus de panique sur un JSON refusé

`src/native/{rtp_receiver,rtp_sender,peer_connection}.rs` (`get_stats`) : le
code d'origine décodait le JSON des statistiques par
`serde_json::from_str(&stats).unwrap()`, **dans le rappel C++**. Le 23/09, un
`RemoteVideoTrack::get_stats()` a reçu un JSON que serde refuse (« key must be
a string ») : panique, abandon du processus, Sion fermé en plein appel.

Le patch passe par `native::parse_stats` (exposé dans `lib.rs` pour être testé
depuis Sion — ce crate, hors de l'espace de travail, ne lance pas ses propres
tests) : un JSON illisible devient une `RtcError` dont le message et le
journal portent l'erreur et une centaine d'octets autour de l'endroit fautif.
La cause elle-même — le JSON produit par libwebrtc — n'est pas encore
identifiée ; ce journal servira à la trouver. Test :
`voice_engine::tests::des_statistiques_illisibles_ne_font_plus_planter`.

À une mise à jour du SDK : retirer si l'amont ne fait plus `unwrap()`.
