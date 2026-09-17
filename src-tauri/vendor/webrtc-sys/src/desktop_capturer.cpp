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
#include <typeinfo>

#include "modules/desktop_capture/desktop_capture_options.h"

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
  // Capturer DirectX (duplication DXGI) desactive par defaut : il abat le
  // processus sur les machines multi-adaptateurs. Trace du crash du 17/09 sur
  // un Windows 11 :
  //   dxgi_adapter_duplicator.cc:116  Cannot initialize any DxgiOutputDuplicator
  //   dxgi_duplicator_controller.cc:286 Failed to initialize ... on adapter 1
  //   screen_capturer_win.cc:30       cree ScreenCapturerWinDirectx
  //   <fin du journal, 0xC0000409>
  // `ScreenCapturerWinDirectx::IsSupported()` repond vrai des qu'UN adaptateur
  // s'initialise, meme si un autre a echoue : libwebrtc choisit alors le
  // chemin DXGI sur une duplication a moitie morte. WGC (Win10 2004+) reste
  // autorise et prioritaire ; sinon le repli GDI prend la main : plus lent,
  // mais il ne tue pas l'application.
  // `SION_ALLOW_DIRECTX_CAPTURER=1` le rearme pour comparer les performances.
  const char* allow_dxgi = std::getenv("SION_ALLOW_DIRECTX_CAPTURER");
  const bool dxgi_opt_in = allow_dxgi != nullptr && allow_dxgi[0] == '1';
  webrtc_options.set_allow_directx_capturer(dxgi_opt_in);
  std::fprintf(stderr, "[Sion][capture] allow_directx_capturer=%d\n",
               dxgi_opt_in ? 1 : 0);
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
    std::fprintf(stderr, "[Sion][capture] aucun capturer disponible\n");
    return nullptr;
  }
  // Ici se trouvait un `typeid(*capturer).name()` de diagnostic. Il abattait le
  // processus sous Windows : `typeid` sur un objet polymorphe exige le RTTI, or
  // libwebrtc est fourni sans RTTI — configuration standard de Chromium —
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