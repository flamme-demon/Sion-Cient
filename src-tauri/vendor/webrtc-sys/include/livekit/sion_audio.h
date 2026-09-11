#pragma once
#include <memory>
#include "api/audio/audio_processing.h"
#include "rust/cxx.h"

namespace livekit_ffi {
struct CaptureProcessingStatus;
std::unique_ptr<webrtc::AudioProcessingBuilderInterface> create_capture_processing_builder();
void configure_capture_processing();
CaptureProcessingStatus capture_processing_status();
bool queue_soundboard_audio(rust::Slice<const int16_t> samples, float gain);
void clear_soundboard_audio();
rust::Vec<float> process_capture_audio(rust::Slice<const float> input, rust::Slice<const float> render, uint32_t sample_rate);
}  // namespace livekit_ffi
