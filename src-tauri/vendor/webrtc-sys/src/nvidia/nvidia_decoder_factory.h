

#ifndef NVIDIA_VIDEO_DECODER_FACTORY_H_
#define NVIDIA_VIDEO_DECODER_FACTORY_H_

#include <vector>

#include "api/environment/environment.h"
#include "api/video_codecs/sdp_video_format.h"
#include "api/video_codecs/video_decoder_factory.h"
#include "cuda_context.h"

namespace webrtc {

class NvidiaVideoDecoderFactory : public VideoDecoderFactory {
 public:
  NvidiaVideoDecoderFactory();
  ~NvidiaVideoDecoderFactory() override;

  static bool IsSupported();

  /// Marque NVDEC comme inutilisable pour tout le processus : une session
  /// cuvid qui échoue lève une `NVDECException`, et sans ce garde-fou le
  /// processus mourait sur abort au premier flux partagé (constaté le 13/09
  /// chez un testeur NVIDIA/pilote 580). Les flux suivants décodent alors en
  /// logiciel.
  static void NoteNvdecFailure(const char* where);

  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override;
  std::unique_ptr<VideoDecoder> Create(
      const Environment& env,
      const SdpVideoFormat& format) override;

 private:
  std::vector<SdpVideoFormat> supported_formats_;
  livekit_ffi::CudaContext* cu_context_;
};

}  // namespace webrtc

#endif  // NVIDIA_VIDEO_DECODER_FACTORY_H_
