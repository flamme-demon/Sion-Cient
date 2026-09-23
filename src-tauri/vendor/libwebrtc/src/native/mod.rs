// Copyright 2025 LiveKit, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#[cfg(target_os = "android")]
pub mod android;
pub mod apm;
pub mod audio_mixer;
pub mod audio_resampler;
pub mod audio_source;
pub mod audio_stream;
pub mod audio_track;
pub mod data_channel;
#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub mod desktop_capturer;
pub mod frame_cryptor;
pub mod ice_candidate;
pub mod media_stream;
pub mod media_stream_track;
pub mod packet_trailer;
pub mod peer_connection;
pub mod peer_connection_factory;
pub mod rtp_parameters;
pub mod rtp_receiver;
pub mod rtp_sender;
pub mod rtp_transceiver;
pub mod session_description;
pub mod video_frame;
pub mod video_source;
pub mod video_stream;
pub mod video_track;
pub mod yuv_helper;

use webrtc_sys::{rtc_error as sys_err, webrtc as sys_rtc};

use crate::{MediaType, RtcError, RtcErrorType};

/// Statistiques JSON de libwebrtc → statistiques typées (patch Sion).
///
/// Le code d'origine faisait `unwrap()` sur ce décodage, dans un rappel C++ :
/// un JSON que serde refuse (« key must be a string », constaté le 23/09 sur
/// un `get_stats()` de piste vidéo reçue) abattait tout le processus. Une
/// statistique illisible devient une erreur, journalisée avec l'endroit du
/// JSON en cause — de quoi trouver la vraie cause la prochaine fois.
///
/// Public pour que Sion puisse le tester : ce crate, hors de l'espace de
/// travail, ne lance pas ses propres tests.
pub fn parse_stats(stats: &str) -> Result<Vec<crate::stats::RtcStats>, RtcError> {
    if stats.is_empty() {
        return Ok(vec![]);
    }
    serde_json::from_str(stats).map_err(|e| {
        let extrait = extrait_autour(stats, e.line(), e.column());
        log::warn!("[libwebrtc] statistiques illisibles : {e} — « {extrait} »");
        RtcError {
            error_type: RtcErrorType::Internal,
            message: format!("statistiques illisibles : {e} — « {extrait} »"),
        }
    })
}

/// Une soixantaine d'octets de part et d'autre de la position d'une erreur,
/// coupés sur des frontières de caractères.
fn extrait_autour(texte: &str, ligne: usize, colonne: usize) -> &str {
    let debut_ligne = texte
        .split_inclusive('\n')
        .take(ligne.saturating_sub(1))
        .map(str::len)
        .sum::<usize>();
    let position = (debut_ligne + colonne.saturating_sub(1)).min(texte.len());
    let mut debut = position.saturating_sub(60);
    while !texte.is_char_boundary(debut) {
        debut -= 1;
    }
    let mut fin = (position + 60).min(texte.len());
    while !texte.is_char_boundary(fin) {
        fin += 1;
    }
    &texte[debut..fin]
}

impl From<sys_err::ffi::RtcErrorType> for RtcErrorType {
    fn from(value: sys_err::ffi::RtcErrorType) -> Self {
        match value {
            sys_err::ffi::RtcErrorType::InvalidState => Self::InvalidState,
            _ => Self::Internal,
        }
    }
}

impl From<sys_err::ffi::RtcError> for RtcError {
    fn from(value: sys_err::ffi::RtcError) -> Self {
        Self { error_type: value.error_type.into(), message: value.message }
    }
}

impl From<MediaType> for sys_rtc::ffi::MediaType {
    fn from(value: MediaType) -> Self {
        match value {
            MediaType::Audio => Self::Audio,
            MediaType::Video => Self::Video,
            MediaType::Data => Self::Data,
            MediaType::Unsupported => Self::Unsupported,
        }
    }
}
