//! Serveur HTTP local pour les médias convertis.
//!
//! **Pourquoi.** Une vidéo convertie était servie à la balise `<video>` par une
//! URL `blob:`. Mesuré le 17/09 sous WebKitGTK : un WebM de 608 Ko reçu tel quel
//! se lit parfaitement, mais nos conversions de 18 et 21 Mo échouent — lecture
//! pendant quelques secondes puis `MEDIA_ERR_DECODE`, ou position qui saute
//! instantanément à la fin. Les fichiers eux-mêmes sont irréprochables :
//! horodatages identiques à la source image par image, décodage logiciel complet
//! par `matroskademux ! vp9dec ! fakesink`, même comportement en VP8 qu'en VP9.
//! Le point commun des échecs n'est ni le codec, ni la résolution, ni le
//! contenu : c'est qu'un `blob:` impose à WebKit de tenir tout le média en
//! mémoire, sans requêtes par plage.
//!
//! Deux autres voies ont été essayées et écartées. Le base64 (héritage CEF)
//! triplait le coût en plus du problème. Le protocole `asset` de Tauri
//! n'atteint jamais le lecteur : les médias passent par le `webkitwebsrc` de
//! GStreamer, qui ne suit pas les gestionnaires de schéma de la webview —
//! aucune requête n'arrivait côté Rust, pas même un refus de portée.
//!
//! Du HTTP sur la boucle locale, lui, est exactement ce qu'un élément média
//! sait consommer : il demande des plages, lit en flux, et ne copie rien.
//!
//! **Portée.** Écoute sur `127.0.0.1` uniquement, sur un port attribué par le
//! système. Ne sert que les fichiers directement contenus dans
//! `sion_media_dir()`, désignés par leur seul nom de fichier — tout chemin
//! contenant un séparateur ou `..` est rejeté avant d'atteindre le disque.

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::OnceLock;

static PORT: OnceLock<u16> = OnceLock::new();

/// Port d'écoute, démarrant le serveur au premier appel. `0` si la socket n'a
/// pas pu être ouverte — l'appelant retombe alors sur le chemin `blob:`.
pub fn port() -> u16 {
    *PORT.get_or_init(|| {
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => listener,
            Err(err) => {
                log::error!("[Sion][vidéo] serveur média indisponible: {err}");
                return 0;
            }
        };
        let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(0);
        log::info!("[Sion][vidéo] serveur média sur 127.0.0.1:{port}");
        std::thread::Builder::new()
            .name("sion-media-http".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    std::thread::spawn(move || {
                        if let Err(err) = serve(stream) {
                            log::debug!("[Sion][vidéo] requête média abandonnée: {err}");
                        }
                    });
                }
            })
            .ok();
        port
    })
}

/// Nom de fichier sûr : un seul segment, pas de séparateur ni de remontée.
fn safe_name(raw: &str) -> Option<String> {
    let name = percent_decode(raw);
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.starts_with('.')
    {
        return None;
    }
    Some(name)
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `Range: bytes=<début>-<fin?>` — une seule plage, la seule forme qu'un
/// élément média émet en pratique.
fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let spec = value.trim().strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    if start.is_empty() {
        // Suffixe : les N derniers octets.
        let n: u64 = end.trim().parse().ok()?;
        let n = n.min(len);
        return Some((len.saturating_sub(n), len.saturating_sub(1)));
    }
    let start: u64 = start.trim().parse().ok()?;
    if start >= len {
        return None;
    }
    let end: u64 = if end.trim().is_empty() {
        len - 1
    } else {
        end.trim().parse::<u64>().ok()?.min(len - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn serve(stream: TcpStream) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();

    let mut range_header: Option<String> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("range") {
                range_header = Some(value.trim().to_string());
            }
        }
    }

    log::info!(
        "[Sion][vidéo] requête média {} {} range={}",
        method,
        target,
        range_header.as_deref().unwrap_or("-")
    );

    let mut stream = stream;
    if method != "GET" && method != "HEAD" {
        return write_status(&mut stream, 405, "Method Not Allowed");
    }
    let Some(name) = target.strip_prefix('/').and_then(safe_name) else {
        return write_status(&mut stream, 400, "Bad Request");
    };
    let path = crate::sion_media_dir().join(&name);
    let mut file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(_) => return write_status(&mut stream, 404, "Not Found"),
    };
    let len = file.metadata()?.len();
    let mime = if name.ends_with(".webm") {
        "video/webm"
    } else if name.ends_with(".mp4") {
        "video/mp4"
    } else {
        "application/octet-stream"
    };

    let range = range_header.as_deref().and_then(|v| parse_range(v, len));
    let (start, end) = range.unwrap_or((0, len.saturating_sub(1)));
    let body_len = end.saturating_sub(start) + 1;

    let mut head = String::new();
    if range.is_some() {
        head.push_str("HTTP/1.1 206 Partial Content\r\n");
        head.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
    } else {
        head.push_str("HTTP/1.1 200 OK\r\n");
    }
    head.push_str(&format!("Content-Type: {mime}\r\n"));
    head.push_str(&format!("Content-Length: {body_len}\r\n"));
    head.push_str("Accept-Ranges: bytes\r\n");
    // La page est servie par le serveur de développement ou par le protocole
    // interne de Tauri : l'origine diffère toujours de celle-ci.
    head.push_str("Access-Control-Allow-Origin: *\r\n");
    head.push_str("Cache-Control: no-store\r\n");
    // Une réponse par connexion. Sans cet en-tête, `HTTP/1.1` promet une
    // connexion persistante que ce serveur ne tient pas : le client enchaîne sa
    // requête suivante sur une socket déjà fermée. `curl` ne le voit pas — il
    // ouvre une connexion par requête — mais un lecteur média multiplie les
    // requêtes par plage sur la même connexion.
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    if method == "HEAD" {
        return Ok(());
    }

    file.seek(SeekFrom::Start(start))?;
    let mut remaining = body_len;
    let mut buf = vec![0u8; 64 * 1024];
    while remaining > 0 {
        let want = buf.len().min(remaining as usize);
        let read = file.read(&mut buf[..want])?;
        if read == 0 {
            break;
        }
        stream.write_all(&buf[..read])?;
        remaining -= read as u64;
    }
    Ok(())
}

fn write_status(stream: &mut TcpStream, code: u16, reason: &str) -> std::io::Result<()> {
    stream.write_all(
        format!(
            "HTTP/1.1 {code} {reason}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
        )
            .as_bytes(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_nom_de_fichier_ne_peut_pas_sortir_du_dossier() {
        assert!(safe_name("sion_out_ab.webm").is_some());
        assert!(safe_name("../../etc/passwd").is_none());
        assert!(safe_name("%2e%2e%2fpasswd").is_none());
        assert!(safe_name("sub/dir.webm").is_none());
        assert!(safe_name("").is_none());
    }

    #[test]
    fn les_plages_couvrent_les_formes_emises_par_un_lecteur() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        // Fin au-delà du fichier : bornée, pas rejetée.
        assert_eq!(parse_range("bytes=90-200", 100), Some((90, 99)));
        // Suffixe : les N derniers octets, ce que demande un lecteur qui
        // cherche l'index d'un WebM.
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        // Début hors fichier : refusé, on répond alors le fichier entier.
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("octets=0-", 100), None);
    }
}
