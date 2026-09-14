#include "nvidia_decoder_factory.h"

#include <modules/video_coding/codecs/h264/include/h264.h>

#include <cstdlib>
#if defined(_WIN32)
// Sion (2026-09-13) : portage Windows — dlfcn n'existe pas, on passe par
// l'API Win32 (LoadLibrary/GetProcAddress), comme cuda_context.cpp le fait
// déjà pour le pilote.
#include <windows.h>
#else
#include <dlfcn.h>
#endif
#include <atomic>
#include <memory>
#include <mutex>

#include "NvDecoder/NvDecoder.h"
#include "cuda_context.h"
#include "h264_decoder_impl.h"
#include "h265_decoder_impl.h"
#include "rtc_base/logging.h"

namespace webrtc {

namespace {

constexpr char kDisableNvdecEnvVar[] = "LK_DISABLE_NVDEC";

bool IsNvdecDisabledByEnv() {
  return std::getenv(kDisableNvdecEnvVar) != nullptr;
}

void LogNvdecDisabledByEnv() {
  static std::once_flag log_once;
  std::call_once(log_once, [] {
    RTC_LOG(LS_INFO) << "NVIDIA NVDEC disabled because " << kDisableNvdecEnvVar
                     << " is set.";
  });
}

/// NVDEC s'est-il révélé inutilisable sur cette machine ? Une fois positionné,
/// on ne propose plus le décodage matériel : les flux suivants décodent en
/// logiciel.
std::atomic<bool> g_nvdec_failed{false};

}  // namespace

void NvidiaVideoDecoderFactory::NoteNvdecFailure(const char* where) {
  if (!g_nvdec_failed.exchange(true)) {
    RTC_LOG(LS_ERROR)
        << "NVDEC marked unusable for this process (failure at " << where
        << ") — falling back to software decoding for later streams.";
  }
}

constexpr char kSdpKeyNameCodecImpl[] = "implementation_name";
constexpr char kCodecName[] = "NvCodec";
#if defined(_WIN32)
// nvcuvid.dll est installée dans System32 par le pilote NVIDIA — le nom POSIX
// ci-dessous n'existe pas sous Windows.
constexpr char kNvdecRuntimeLibrary[] = "nvcuvid.dll";
#else
constexpr char kNvdecRuntimeLibrary[] = "libnvcuvid.so.1";
#endif

namespace {

bool IsNvdecRuntimeAvailable() {
#if defined(_WIN32)
  void* hModule = reinterpret_cast<void*>(LoadLibraryA(kNvdecRuntimeLibrary));
#else
  void* hModule = dlopen(kNvdecRuntimeLibrary, RTLD_LAZY | RTLD_LOCAL);
#endif
  if (!hModule) {
    RTC_LOG(LS_WARNING) << "NVDEC runtime library (" << kNvdecRuntimeLibrary
                        << ") not found, hardware decoding unavailable.";
    return false;
  }

#if defined(_WIN32)
  FreeLibrary(reinterpret_cast<HMODULE>(hModule));
#else
  dlclose(hModule);
#endif
  return true;
}

}  // namespace

static int GetCudaDeviceCapabilityMajorVersion(CUcontext context) {
  cuCtxSetCurrent(context);

  CUdevice device;
  cuCtxGetDevice(&device);

  int major;
  cuDeviceGetAttribute(&major, CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MAJOR,
                       device);

  return major;
}

std::vector<SdpVideoFormat> SupportedNvDecoderCodecs(CUcontext context) {
  std::vector<SdpVideoFormat> supportedFormats;

  // HardwareGeneration Kepler is 3.x
  // https://docs.nvidia.com/deploy/cuda-compatibility/index.html#faq
  // Kepler support h264 profile Main, Highprofile up to Level4.1
  // https://docs.nvidia.com/video-technologies/video-codec-sdk/nvdec-video-decoder-api-prog-guide/index.html#video-decoder-capabilities__table_o3x_fms_3lb
  if (GetCudaDeviceCapabilityMajorVersion(context) <= 3) {
    supportedFormats = {
        CreateH264Format(webrtc::H264Profile::kProfileHigh,
                         webrtc::H264Level::kLevel4_1, "1"),
        CreateH264Format(webrtc::H264Profile::kProfileMain,
                         webrtc::H264Level::kLevel4_1, "1"),
    };
  } else {
    supportedFormats = {
        // Constrained Baseline Profile does not support NvDecoder, but WebRTC
        // uses this profile by default,
        // so it must be returned in this method.
        CreateH264Format(webrtc::H264Profile::kProfileConstrainedBaseline,
                         webrtc::H264Level::kLevel5_1, "1"),
        CreateH264Format(webrtc::H264Profile::kProfileBaseline,
                         webrtc::H264Level::kLevel5_1, "1"),
        CreateH264Format(webrtc::H264Profile::kProfileHigh,
                         webrtc::H264Level::kLevel5_1, "1"),
        CreateH264Format(webrtc::H264Profile::kProfileMain,
                         webrtc::H264Level::kLevel5_1, "1"),
        SdpVideoFormat("H265"),
        SdpVideoFormat("HEVC"),
    };
  }

  for (auto& format : supportedFormats) {
    format.parameters.emplace(kSdpKeyNameCodecImpl, kCodecName);
  }

  return supportedFormats;
}

NvidiaVideoDecoderFactory::NvidiaVideoDecoderFactory()
    : cu_context_(nullptr) {
  if (IsNvdecDisabledByEnv()) {
    LogNvdecDisabledByEnv();
    return;
  }

  if (!IsNvdecRuntimeAvailable()) {
    RTC_LOG(LS_INFO) << "NvidiaVideoDecoderFactory created without NVDEC "
                        "support because the runtime library is unavailable.";
    return;
  }

  cu_context_ = livekit_ffi::CudaContext::GetInstance();
  if (cu_context_->Initialize()) {
    supported_formats_ = SupportedNvDecoderCodecs(cu_context_->GetContext());
  } else {
    RTC_LOG(LS_ERROR) << "Failed to initialize CUDA context.";
  }

  // ── Sonde RÉELLE (13/09) ────────────────────────────────────────────────
  // `IsNvdecRuntimeAvailable()` ne fait qu'un `dlopen` : il prouve que la
  // bibliothèque est là, pas que le pilote sait ouvrir une session de décodage
  // H264 sur ce GPU. On ouvre donc une vraie session (et on la détruit
  // aussitôt) ; si ça lève, NVDEC est marqué inutilisable et aucun flux ne
  // tentera le décodage matériel.
  if (!supported_formats_.empty()) {
    try {
      NvDecoder probe(cu_context_->GetContext(), false, cudaVideoCodec_H264,
                      true, false, nullptr, nullptr, false, 4096, 4096);
    } catch (const std::exception& e) {
      NoteNvdecFailure("probe");
      RTC_LOG(LS_ERROR) << "NVDEC probe failed: " << e.what();
      supported_formats_.clear();
      return;
    }
  }

  RTC_LOG(LS_INFO) << "NvidiaVideoDecoderFactory created with "
                   << supported_formats_.size() << " supported formats.";
}

NvidiaVideoDecoderFactory::~NvidiaVideoDecoderFactory() {}

bool NvidiaVideoDecoderFactory::IsSupported() {
  if (g_nvdec_failed.load(std::memory_order_relaxed)) {
    return false;
  }

  if (IsNvdecDisabledByEnv()) {
    LogNvdecDisabledByEnv();
    return false;
  }

  if (!livekit_ffi::CudaContext::IsAvailable()) {
    RTC_LOG(LS_WARNING) << "Cuda Context is not available.";
    return false;
  }

  if (!IsNvdecRuntimeAvailable()) {
    return false;
  }

  std::cout << "Nvidia Decoder is supported." << std::endl;
  return true;
}

std::unique_ptr<VideoDecoder> NvidiaVideoDecoderFactory::Create(
    const Environment& env,
    const SdpVideoFormat& format) {
  // Check if the requested format is supported.
  for (const auto& supported_format : supported_formats_) {
    if (format.IsSameCodec(supported_format)) {
      // If the format is supported, create and return the decoder.
      if (!cu_context_) {
        cu_context_ = livekit_ffi::CudaContext::GetInstance();
        if (!cu_context_->Initialize()) {
          RTC_LOG(LS_ERROR) << "Failed to initialize CUDA context.";
          return nullptr;
        }
      }
      if (format.name == "H264") {
        RTC_LOG(LS_INFO) << "Using NVIDIA HW decoder (NVDEC) for H264";
        try {
          return std::make_unique<NvidiaH264DecoderImpl>(cu_context_->GetContext());
        } catch (const std::exception& e) {
          NoteNvdecFailure("Create H264");
          RTC_LOG(LS_ERROR) << "NVDEC H264 decoder creation failed: " << e.what();
          return nullptr;
        }
      }
      if (format.name == "H265" || format.name == "HEVC") {
        RTC_LOG(LS_INFO) << "Using NVIDIA HW decoder (NVDEC) for H265/HEVC";
        try {
          return std::make_unique<NvidiaH265DecoderImpl>(cu_context_->GetContext());
        } catch (const std::exception& e) {
          NoteNvdecFailure("Create H265");
          RTC_LOG(LS_ERROR) << "NVDEC H265 decoder creation failed: " << e.what();
          return nullptr;
        }
      }
    }
  }
  return nullptr;
}

std::vector<SdpVideoFormat> NvidiaVideoDecoderFactory::GetSupportedFormats()
    const {
  return supported_formats_;
}

}  // namespace webrtc
