/*
 * Copyright 2025 LiveKit, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include <cstdlib>
#include "livekit/desktop_capturer.h"

#include <cstdio>

#include "modules/desktop_capture/desktop_and_cursor_composer.h"
#include "modules/desktop_capture/desktop_capture_options.h"
#include "rtc_base/logging.h"

using SourceList = webrtc::DesktopCapturer::SourceList;

namespace livekit_ffi {

std::unique_ptr<DesktopCapturer> new_desktop_capturer(
    DesktopCapturerOptions options) {
  webrtc::DesktopCaptureOptions webrtc_options =
      webrtc::DesktopCaptureOptions::CreateDefault();
#if defined(WEBRTC_MAC) && !defined(WEBRTC_IOS)
  webrtc_options.set_allow_sck_capturer(true);
  webrtc_options.set_allow_sck_system_picker(options.allow_sck_system_picker);
#endif /* defined(WEBRTC_MAC) && !defined(WEBRTC_IOS) */
#ifdef _WIN64
  switch (options.source_type) {
    case SourceType::Screen:
      webrtc_options.set_allow_wgc_screen_capturer(true);
      break;
    case SourceType::Window:
      webrtc_options.set_allow_wgc_window_capturer(true);
      // https://github.com/webrtc-sdk/webrtc/blob/m137_release/modules/desktop_capture/desktop_capture_options.h#L133-L142
      webrtc_options.set_enumerate_current_process_windows(false);
      break;
    default:
      break;
  }
  // Capturer DirectX (duplication DXGI) actif.
  //
  // Il a ete soupconne puis mis hors de cause. Le 17/09, un partage abattait le
  // processus (0xC0000409) et la trace s'arretait juste apres la creation d'un
  // ScreenCapturerWinDirectx : DXGI a donc ete desarme, ce qui a bien stoppe les
  // plantages. Le vrai coupable etait ailleurs : un `typeid` sur un objet
  // libwebrtc compile sans RTTI, quelques lignes plus bas dans ce fichier. Une
  // fois celui-ci retire, DXGI a ete reactive et mesure : aucun plantage, et
  // 26 im/s capturees contre 14,7 en repli GDI.
  //
  // `SION_FORCE_GDI_CAPTURER=1` force le repli logiciel pour diagnostiquer.
  const char* force_gdi = std::getenv("SION_FORCE_GDI_CAPTURER");
  const bool gdi_only = force_gdi != nullptr && force_gdi[0] == '1';
  webrtc_options.set_allow_directx_capturer(!gdi_only);
#endif /* _WIN64 */
#ifdef WEBRTC_USE_PIPEWIRE
  webrtc_options.set_allow_pipewire(true);
  std::fprintf(stderr,
               "[Sion][capture] options allow_pipewire=%d\n",
               webrtc_options.allow_pipewire() ? 1 : 0);
#else
  std::fprintf(stderr, "[Sion][capture] WEBRTC_USE_PIPEWIRE non defini\n");
#endif /* WEBRTC_USE_PIPEWIRE */

  // prefer_cursor_embedded indicate that the capturer should try to include the
  // cursor in the frame
  webrtc_options.set_prefer_cursor_embedded(options.include_cursor);

  std::unique_ptr<webrtc::DesktopCapturer> capturer = nullptr;
  switch (options.source_type) {
    case SourceType::Window:
      capturer = webrtc::DesktopCapturer::CreateWindowCapturer(webrtc_options);
      break;
    case SourceType::Screen:
      capturer = webrtc::DesktopCapturer::CreateScreenCapturer(webrtc_options);
      break;
    case SourceType::Generic:
      capturer = webrtc::DesktopCapturer::CreateGenericCapturer(webrtc_options);
      break;
    default:
      return nullptr;
  }

  if (!capturer) {
    RTC_LOG(LS_ERROR) << "[Sion][capture] aucun capturer disponible";
    return nullptr;
  }

#ifdef _WIN64
  // Incrustation du curseur systeme, a notre charge sous Windows.
  //
  // `prefer_cursor_embedded` n'est qu'un indicateur range dans les options :
  // aucune des fabriques `Create*Capturer` ne l'applique. Les deux capturers
  // Windows rendent le bureau SANS pointeur — la duplication DXGI le livre a
  // part, en metadonnee, et le chemin GDI ne le dessine pas davantage. Le
  // curseur systeme manquait donc dans tous les partages Windows (17/09)
  // alors que l'option etait correctement cablee jusqu'ici.
  //
  // `DesktopAndCursorComposer` fait le travail : il suit la forme et la
  // position du pointeur et les compose sur chaque image. On ne l'enveloppe
  // que sous Windows — ailleurs certains capturers (PipeWire) incrustent
  // nativement, et doubler la composition dessinerait deux pointeurs.
  // Composition ACTIVE par defaut. Elle est restee sous interrupteur le temps
  // d'ecarter un soupcon : le premier essai coincidait avec un partage reduit
  // a des images 2x2. L'historique des journaux a montre que ces images
  // existaient AVANT ce changement — elles marquent la fin d'un partage — et
  // la session du 18/09 a confirme que le curseur systeme apparait enfin.
  // `SION_DISABLE_CURSOR_COMPOSER=1` revient en arriere si besoin.
  const bool composer_on = std::getenv("SION_DISABLE_CURSOR_COMPOSER") == nullptr;
  if (options.include_cursor && composer_on) {
    capturer = std::make_unique<webrtc::DesktopAndCursorComposer>(
        std::move(capturer), webrtc_options);
    RTC_LOG(LS_WARNING) << "[Sion][capture] curseur systeme compose par "
                           "DesktopAndCursorComposer";
  } else if (options.include_cursor) {
    RTC_LOG(LS_WARNING) << "[Sion][capture] composition du curseur desactivee "
                           "(SION_DISABLE_CURSOR_COMPOSER pose)";
  }
#endif /* _WIN64 */
  // Journalise par le canal de webrtc, pas par `stderr` : une application
  // compilee en `windows_subsystem = "windows"` n'a pas de console, donc les
  // `fprintf` de ce fichier n'ont jamais eu de lecteur. Les messages de webrtc,
  // eux, arrivent bien dans le journal de l'application.
  //
  // On a d'abord cru que `prefer_cursor_embedded` suffisait a faire envelopper
  // le capturer. C'est faux : aucune fabrique ne le lit, il ne renseigne que
  // les capturers qui savent incruster nativement. La trace reste utile — elle
  // confirme que la demande de l'utilisateur atteint bien cette couche — mais
  // c'est le `DesktopAndCursorComposer` ci-dessus qui dessine le pointeur.
  RTC_LOG(LS_WARNING) << "[Sion][capture] prefer_cursor_embedded="
                      << webrtc_options.prefer_cursor_embedded()
                      << " source_type=" << static_cast<int>(options.source_type);
  // Ici se trouvait un `typeid(*capturer).name()` de diagnostic. Il abattait le
  // processus sous Windows : `typeid` sur un objet polymorphe exige le RTTI, or
  // libwebrtc est fourni sans RTTI (configuration standard de Chromium)
  // tandis que ce fichier est compile avec (defaut de MSVC). Lire dans la
  // vtable une information qui n'y est pas se termine en `abort()`, vu le
  // 17/09 comme un 0xC0000409 dans `ucrtbase.dll` des qu'un partage demarrait.
  //
  // La ligne etait de toute facon inutile : libwebrtc journalise lui-meme le
  // type de capturer qu'il cree (`screen_capturer_win.cc`), et `stderr` n'a
  // aucun lecteur dans une application sans console.
  return std::make_unique<DesktopCapturer>(std::move(capturer));
}

void DesktopCapturer::start(
    rust::Box<DesktopCapturerCallbackWrapper> callback) {
  this->callback = std::move(callback);
  capturer->Start(this);
}

void DesktopCapturer::OnCaptureResult(
    webrtc::DesktopCapturer::Result result,
    std::unique_ptr<webrtc::DesktopFrame> frame) {
  CaptureResult ret_result = CaptureResult::ErrorPermanent;
  switch (result) {
    case webrtc::DesktopCapturer::Result::SUCCESS:
      ret_result = CaptureResult::Success;
      break;
    case webrtc::DesktopCapturer::Result::ERROR_PERMANENT:
      ret_result = CaptureResult::ErrorPermanent;
      break;
    case webrtc::DesktopCapturer::Result::ERROR_TEMPORARY:
      ret_result = CaptureResult::ErrorTemporary;
      break;
    default:
      break;
  }
  // Taille des premieres images. Un partage Windows a emis des images 2x2
  // (17/09) : impossible de dire, depuis le seul flux recu, si le capturer
  // les produisait deja ainsi ou si la degradation survenait plus loin dans
  // la chaine. On journalise donc les toutes premieres, puis on se tait —
  // une ligne par image noierait le journal pendant tout le partage.
  static int images_tracees = 0;
  if (images_tracees < 5) {
    ++images_tracees;
    if (frame) {
      RTC_LOG(LS_WARNING) << "[Sion][capture] image #" << images_tracees
                          << " " << frame->size().width() << "x"
                          << frame->size().height()
                          << " resultat=" << static_cast<int>(result);
    } else {
      RTC_LOG(LS_WARNING) << "[Sion][capture] image #" << images_tracees
                          << " ABSENTE resultat=" << static_cast<int>(result);
    }
  }
  if (callback) {
    (*callback)->on_capture_result(
        ret_result, std::make_unique<DesktopFrame>(std::move(frame)));
  }
}

rust::Vec<Source> DesktopCapturer::get_source_list() const {
  SourceList list{};
  bool res = capturer->GetSourceList(&list);
  rust::Vec<Source> source_list{};
  if (res) {
    for (auto& source : list) {
      source_list.push_back(Source{static_cast<uint64_t>(source.id),
                                   source.title, source.display_id});
    }
  }
  return source_list;
}
}  // namespace livekit_ffi