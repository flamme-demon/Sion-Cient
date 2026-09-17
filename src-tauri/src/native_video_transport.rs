//! Transport local binaire des images de partage reçues.
//!
//! Les gros JPEG ne passent plus dans `tauri::emit` (JSON + base64). Un
//! WebSocket local transmet un paquet binaire borné par frame ; chaque client
//! ne garde qu'une image en attente, donc un webview lent ne crée aucun backlog.

use std::collections::HashMap;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

use tungstenite::Message;

const MAGIC: &[u8; 4] = b"SVF1";
const HEADER_LEN: usize = 14;

static PORT: OnceLock<u16> = OnceLock::new();
static CLIENTS: OnceLock<Mutex<Vec<Arc<ClientQueue>>>> = OnceLock::new();
static LAST_PACKETS: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();

/// Une seule image récente par expéditeur et par webview. Si Rust produit
/// plusieurs images pendant que WebKit en décode une, la plus récente écrase
/// l'ancienne : mémoire bornée et aucune dette de lecture.
struct ClientQueue {
    frames: Mutex<HashMap<String, Vec<u8>>>,
    wake: Condvar,
    connected: AtomicBool,
}

fn clients() -> &'static Mutex<Vec<Arc<ClientQueue>>> {
    CLIENTS.get_or_init(|| Mutex::new(Vec::new()))
}

fn last_packets() -> &'static Mutex<HashMap<String, Vec<u8>>> {
    LAST_PACKETS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn port() -> u16 {
    *PORT.get_or_init(|| {
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => listener,
            Err(err) => {
                log::error!("[Sion][partage-natif] transport vidéo indisponible: {err}");
                return 0;
            }
        };
        let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(0);
        log::info!("[Sion][partage-natif] transport vidéo binaire sur 127.0.0.1:{port}");
        std::thread::Builder::new()
            .name("sion-native-video-ws".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let _ = stream.set_nodelay(true);
                    let Ok(mut socket) = tungstenite::accept(stream) else {
                        continue;
                    };
                    log::info!("[Sion][partage-natif] client vidéo WebSocket connecté");
                    let queue = Arc::new(ClientQueue {
                        // Amorcer avec les partages déjà reçus : un écran
                        // immobile reste visible même si la vue se connecte
                        // après sa dernière frame encodée.
                        frames: Mutex::new(
                            last_packets()
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .clone(),
                        ),
                        wake: Condvar::new(),
                        connected: AtomicBool::new(true),
                    });
                    clients()
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push(queue.clone());
                    let mut sent_first = false;
                    std::thread::spawn(move || loop {
                        let packets = {
                            let mut frames = queue.frames.lock().unwrap_or_else(|e| e.into_inner());
                            while frames.is_empty() {
                                frames = queue.wake.wait(frames).unwrap_or_else(|e| e.into_inner());
                            }
                            frames.drain().map(|(_, packet)| packet).collect::<Vec<_>>()
                        };
                        for packet in packets {
                            if !sent_first {
                                sent_first = true;
                                log::info!("[Sion][partage-natif] envoi première frame au client ({} octets)", packet.len());
                            }
                            if socket.send(Message::Binary(packet.into())).is_err() {
                                log::info!("[Sion][partage-natif] client vidéo WebSocket déconnecté");
                                queue.connected.store(false, Ordering::Release);
                                return;
                            }
                        }
                    });
                }
            })
            .ok();
        port
    })
}

fn packet(sender: &str, width: u32, height: u32, jpeg: &[u8]) -> Option<Vec<u8>> {
    let sender = sender.as_bytes();
    let sender_len = u16::try_from(sender.len()).ok()?;
    let mut out = Vec::with_capacity(HEADER_LEN + sender.len() + jpeg.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&sender_len.to_le_bytes());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(sender);
    out.extend_from_slice(jpeg);
    Some(out)
}

/// Décode le cache de dernière image pour son garde-fou unitaire. En
/// production, ce cache amorce directement chaque nouvelle file WebSocket.
#[cfg(test)]
pub fn latest_frame(sender: &str) -> Option<(u32, u32, Vec<u8>)> {
    let packets = last_packets().lock().unwrap_or_else(|e| e.into_inner());
    let packet = packets.get(sender)?;
    if packet.len() < HEADER_LEN || &packet[..4] != MAGIC {
        return None;
    }
    let sender_len = u16::from_le_bytes([packet[4], packet[5]]) as usize;
    let jpeg_offset = HEADER_LEN.checked_add(sender_len)?;
    if jpeg_offset >= packet.len() {
        return None;
    }
    let width = u32::from_le_bytes(packet[6..10].try_into().ok()?);
    let height = u32::from_le_bytes(packet[10..14].try_into().ok()?);
    if width == 0 || height == 0 {
        return None;
    }
    Some((width, height, packet[jpeg_offset..].to_vec()))
}

pub fn broadcast(sender: &str, width: u32, height: u32, jpeg: &[u8]) {
    // Initialise le serveur au premier partage même si le front n'a pas encore
    // demandé le port. La première image peut être perdue, jamais mise en file.
    if port() == 0 {
        return;
    }
    let Some(packet) = packet(sender, width, height, jpeg) else {
        return;
    };
    last_packets()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(sender.to_owned(), packet.clone());
    clients()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|client| {
            if !client.connected.load(Ordering::Acquire) {
                return false;
            }
            client
                .frames
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(sender.to_owned(), packet.clone());
            client.wake.notify_one();
            true
        });
}

/// Oublie l'image d'un partage terminé, côté cache global comme dans les
/// files des webviews. Cela évite de réafficher une vieille frame après une
/// reconnexion de la vue.
pub fn remove(sender: &str) {
    // Le PIP natif suit le partage : s'il affichait celui-ci, il se ferme.
    #[cfg(not(target_os = "android"))]
    crate::pip_window::on_share_removed(sender);
    last_packets()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(sender);
    for client in clients().lock().unwrap_or_else(|e| e.into_inner()).iter() {
        client
            .frames
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(sender);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packet_video_est_binaire_et_auto_decrit() {
        let jpeg = [0xff, 0xd8, 1, 2, 0xff, 0xd9];
        let bytes = packet("@picsou:sion", 1920, 804, &jpeg).unwrap();
        assert_eq!(&bytes[..4], b"SVF1");
        let name_len = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
        assert_eq!(u32::from_le_bytes(bytes[6..10].try_into().unwrap()), 1920);
        assert_eq!(u32::from_le_bytes(bytes[10..14].try_into().unwrap()), 804);
        assert_eq!(&bytes[14..14 + name_len], b"@picsou:sion");
        assert_eq!(&bytes[14 + name_len..], jpeg);
    }

    #[test]
    fn derniere_frame_peut_amorcer_un_consommateur_tardif() {
        let sender = "@statique:sion";
        let jpeg = [0xff, 0xd8, 7, 8, 0xff, 0xd9];
        let bytes = packet(sender, 1280, 720, &jpeg).unwrap();
        last_packets()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(sender.into(), bytes);

        assert_eq!(latest_frame(sender), Some((1280, 720, jpeg.to_vec())));
    }
}
