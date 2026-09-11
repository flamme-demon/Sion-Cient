#include "livekit/sion_audio.h"
#include "webrtc-sys/src/sion_audio.rs.h"
#include "api/audio/builtin_audio_processing_builder.h"
#include "api/environment/environment_factory.h"
#include "common_audio/resampler/include/push_resampler.h"
#include "modules/audio_processing/audio_buffer.h"
#include "rtc_base/ref_counted_object.h"
#include "api/make_ref_counted.h"
#include "modules/audio_processing/include/aec_dump.h"
#include <algorithm>
#include <array>
#include <mutex>
#include <stdexcept>
#include <vector>

namespace livekit_ffi {
namespace {
// Owned by APM and called on its capture thread. RNNoise works on 48 kHz / 10ms
// frames; WebRTC's resamplers preserve support for 16/32 kHz capture as well.
class CapturePostProcessor : public webrtc::CustomProcessing {
 public:
  CapturePostProcessor() : processor_(new_capture_processor()) {}
  void Initialize(int rate, int channels) override {
    processor_->initialize(channels);
    frames_ = rate / 100;
    up_.clear(); down_.clear();
    for (int channel = 0; channel < channels; ++channel) {
      up_.push_back(std::make_unique<webrtc::PushResampler<float>>(frames_, 480, 1));
      down_.push_back(std::make_unique<webrtc::PushResampler<float>>(480, frames_, 1));
    }
  }
  void Process(webrtc::AudioBuffer* audio) override {
    if (audio->num_frames() != frames_ || audio->num_channels() > up_.size()) return;
    for (size_t channel = 0; channel < audio->num_channels(); ++channel) {
      float* data = audio->channels()[channel];
      if (frames_ == 480 || !capture_settings().noise_suppression) {
        processor_->process_channel(channel, rust::Slice<float>(data, frames_));
      } else {
        up_[channel]->Resample(webrtc::MonoView<const float>(data, frames_),
                              webrtc::MonoView<float>(buffer_.data(), 480));
        processor_->process_channel(channel, rust::Slice<float>(buffer_.data(), 480));
        down_[channel]->Resample(webrtc::MonoView<const float>(buffer_.data(), 480),
                                webrtc::MonoView<float>(data, frames_));
      }
    }
  }
  std::string ToString() const override { return "Sion RNNoise capture post-processing"; }
 private:
  rust::Box<CaptureProcessor> processor_;
  size_t frames_ = 0;
  std::array<float, 480> buffer_{};
  std::vector<std::unique_ptr<webrtc::PushResampler<float>>> up_, down_;
};

// Mixes soundboard clips into the render frame before AEC analyzes it. The
// clip is therefore heard on the PlatformAudio output and is part of the exact
// echo reference used for microphone capture.
class SoundboardRenderProcessor : public webrtc::CustomProcessing {
 public:
  void Initialize(int rate, int channels) override {
    frames_ = rate / 100;
    soundboard_native_.assign(frames_, 0.0f);
    resampler_ = frames_ == 480
        ? nullptr
        : std::make_unique<webrtc::PushResampler<float>>(480, frames_, 1);
  }
  void Process(webrtc::AudioBuffer* audio) override {
    if (audio->num_frames() != frames_ || audio->num_channels() == 0) return;
    soundboard_48k_.fill(0.0f);
    mix_soundboard_render(rust::Slice<float>(soundboard_48k_.data(), 480));
    const float* soundboard = soundboard_48k_.data();
    if (resampler_) {
      resampler_->Resample(webrtc::MonoView<const float>(soundboard_48k_.data(), 480),
                           webrtc::MonoView<float>(soundboard_native_.data(), frames_));
      soundboard = soundboard_native_.data();
    }
    for (size_t channel = 0; channel < audio->num_channels(); ++channel) {
      float* out = audio->channels()[channel];
      for (size_t frame = 0; frame < frames_; ++frame) {
        out[frame] = std::clamp(out[frame] + soundboard[frame], -32768.0f, 32767.0f);
      }
    }
  }
  std::string ToString() const override { return "Sion soundboard render mixer"; }
 private:
  size_t frames_ = 0;
  std::array<float, 480> soundboard_48k_{};
  std::vector<float> soundboard_native_;
  std::unique_ptr<webrtc::PushResampler<float>> resampler_;
};

struct ProcessingState {
  webrtc::scoped_refptr<webrtc::AudioProcessing> apm;
  std::mutex config_mutex;
  void Apply(webrtc::AudioProcessing::Config config) {
    std::lock_guard<std::mutex> lock(config_mutex);
    auto options = capture_settings();
    config.pipeline.maximum_internal_processing_rate = 48000;
    config.echo_canceller.enabled = options.echo_cancellation;
    // Digital AGC avoids modifying the hardware microphone level.
    config.gain_controller1.enabled = false;
    config.gain_controller2.enabled = options.auto_gain_control;
    config.gain_controller2.adaptive_digital.enabled = options.auto_gain_control;
    config.gain_controller2.input_volume_controller.enabled = false;
    // RNNoise owns noise suppression; disabling RNNoise means no suppression.
    config.noise_suppression.enabled = false;
    apm->ApplyConfig(config);
  }
};
std::mutex registry_mutex;
std::vector<std::weak_ptr<ProcessingState>> registry;

// WebRTC reapplies audio options when a stream is published or reconnected.
// Enforce the application preferences at that boundary too, so publishing
// screen-share audio cannot silently switch off the microphone's AEC.
class CaptureApm : public webrtc::AudioProcessing {
 public:
  explicit CaptureApm(std::shared_ptr<ProcessingState> state) : state_(std::move(state)) {}
  int Initialize() override { return state_->apm->Initialize(); }
  int Initialize(const webrtc::ProcessingConfig& config) override { return state_->apm->Initialize(config); }
  void ApplyConfig(const Config& config) override { state_->Apply(config); }
  int proc_sample_rate_hz() const override { return state_->apm->proc_sample_rate_hz(); }
  int proc_split_sample_rate_hz() const override { return state_->apm->proc_split_sample_rate_hz(); }
  size_t num_input_channels() const override { return state_->apm->num_input_channels(); }
  size_t num_proc_channels() const override { return state_->apm->num_proc_channels(); }
  size_t num_output_channels() const override { return state_->apm->num_output_channels(); }
  size_t num_reverse_channels() const override { return state_->apm->num_reverse_channels(); }
  void set_output_will_be_muted(bool value) override { state_->apm->set_output_will_be_muted(value); }
  bool get_output_will_be_muted() override { return state_->apm->get_output_will_be_muted(); }
  void SetRuntimeSetting(RuntimeSetting value) override { state_->apm->SetRuntimeSetting(value); }
  bool PostRuntimeSetting(RuntimeSetting value) override { return state_->apm->PostRuntimeSetting(value); }
  int ProcessStream(const int16_t* src, const webrtc::StreamConfig& in, const webrtc::StreamConfig& out, int16_t* dst) override { return state_->apm->ProcessStream(src, in, out, dst); }
  int ProcessStream(const float* const* src, const webrtc::StreamConfig& in, const webrtc::StreamConfig& out, float* const* dst) override { return state_->apm->ProcessStream(src, in, out, dst); }
  int ProcessReverseStream(const int16_t* src, const webrtc::StreamConfig& in, const webrtc::StreamConfig& out, int16_t* dst) override { return state_->apm->ProcessReverseStream(src, in, out, dst); }
  int ProcessReverseStream(const float* const* src, const webrtc::StreamConfig& in, const webrtc::StreamConfig& out, float* const* dst) override { return state_->apm->ProcessReverseStream(src, in, out, dst); }
  int AnalyzeReverseStream(const float* const* src, const webrtc::StreamConfig& config) override { return state_->apm->AnalyzeReverseStream(src, config); }
  bool GetLinearAecOutput(std::span<std::array<float, 160>> output) const override { return state_->apm->GetLinearAecOutput(output); }
  void set_stream_analog_level(int level) override { state_->apm->set_stream_analog_level(level); }
  int recommended_stream_analog_level() const override { return state_->apm->recommended_stream_analog_level(); }
  int set_stream_delay_ms(int delay) override { return state_->apm->set_stream_delay_ms(delay); }
  int stream_delay_ms() const override { return state_->apm->stream_delay_ms(); }
  void set_stream_key_pressed(bool value) override { state_->apm->set_stream_key_pressed(value); }
  bool CreateAndAttachAecDump(absl::string_view file, int64_t size, webrtc::TaskQueueBase* queue) override { return state_->apm->CreateAndAttachAecDump(file, size, queue); }
  bool CreateAndAttachAecDump(FILE* file, int64_t size, webrtc::TaskQueueBase* queue) override { return state_->apm->CreateAndAttachAecDump(file, size, queue); }
  void AttachAecDump(std::unique_ptr<webrtc::AecDump> dump) override { state_->apm->AttachAecDump(std::move(dump)); }
  void DetachAecDump() override { state_->apm->DetachAecDump(); }
  webrtc::AudioProcessingStats GetStatistics() override { return state_->apm->GetStatistics(); }
  webrtc::AudioProcessingStats GetStatistics(bool remote) override { return state_->apm->GetStatistics(remote); }
  Config GetConfig() const override { return state_->apm->GetConfig(); }
 private:
  std::shared_ptr<ProcessingState> state_;
};

class CaptureBuilder : public webrtc::AudioProcessingBuilderInterface {
 public:
  webrtc::scoped_refptr<webrtc::AudioProcessing> Build(const webrtc::Environment& env) override {
    auto state = std::make_shared<ProcessingState>();
    webrtc::BuiltinAudioProcessingBuilder builder;
    builder.SetCapturePostProcessing(std::make_unique<CapturePostProcessor>());
    builder.SetRenderPreProcessing(std::make_unique<SoundboardRenderProcessor>());
    state->apm = builder.Build(env);
    if (!state->apm) return nullptr;
    state->Apply(state->apm->GetConfig());
    {
      std::lock_guard<std::mutex> lock(registry_mutex);
      std::erase_if(registry, [](const auto& weak) { return weak.expired(); });
      registry.push_back(state);
    }
    return webrtc::make_ref_counted<CaptureApm>(std::move(state));
  }
};
}  // namespace

std::unique_ptr<webrtc::AudioProcessingBuilderInterface> create_capture_processing_builder() {
  return std::make_unique<CaptureBuilder>();
}
void configure_capture_processing() {
  std::lock_guard<std::mutex> lock(registry_mutex);
  std::erase_if(registry, [](const auto& weak) { return weak.expired(); });
  for (const auto& weak : registry) {
    if (auto state = weak.lock()) state->Apply(state->apm->GetConfig());
  }
}
CaptureProcessingStatus capture_processing_status() {
  CaptureProcessingStatus status{};
  std::lock_guard<std::mutex> lock(registry_mutex);
  for (const auto& weak : registry) {
    if (auto state = weak.lock()) {
      ++status.instances;
      const auto config = state->apm->GetConfig();
      status.echo_cancellation = config.echo_canceller.enabled;
      status.auto_gain_control = config.gain_controller1.enabled || config.gain_controller2.enabled;
      status.webrtc_noise_suppression = config.noise_suppression.enabled;
    }
  }
  return status;
}
bool queue_soundboard_audio(rust::Slice<const int16_t> samples, float gain) {
  return enqueue_soundboard_audio_rs(samples, gain);
}
void clear_soundboard_audio() {
  clear_soundboard_audio_rs();
}
rust::Vec<float> process_capture_audio(rust::Slice<const float> input, rust::Slice<const float> render, uint32_t rate) {
  rust::Vec<float> output;
  if ((rate != 16000 && rate != 32000 && rate != 48000) || input.size() % (rate / 100) != 0) return output;
  if (!render.empty() && render.size() != input.size()) return output;
  auto apm = CaptureBuilder().Build(webrtc::CreateEnvironment());
  // Simulate the SDK reapplying contradictory defaults after publication.
  auto defaults = apm->GetConfig();
  defaults.echo_canceller.enabled = !capture_settings().echo_cancellation;
  defaults.noise_suppression.enabled = true;
  defaults.gain_controller2.enabled = !capture_settings().auto_gain_control;
  apm->ApplyConfig(defaults);
  const auto applied = apm->GetConfig();
  if (applied.echo_canceller.enabled != capture_settings().echo_cancellation || applied.noise_suppression.enabled ||
      applied.gain_controller2.enabled != capture_settings().auto_gain_control) return output;
  const size_t frames = rate / 100;
  std::vector<float> frame(frames), silence(frames, 0.0f), render_output(frames);
  webrtc::StreamConfig config(rate, 1);
  for (size_t offset = 0; offset < input.size(); offset += frames) {
    const float* reverse = render.empty() ? silence.data() : render.data() + offset;
    float* played = render_output.data();
    if (apm->ProcessReverseStream(&reverse, config, config, &played) != 0) return {};
    apm->set_stream_delay_ms(0);
    const float* src = input.data() + offset;
    float* dst = frame.data();
    if (apm->ProcessStream(&src, config, config, &dst) != 0) return {};
    for (float sample : frame) output.push_back(sample);
  }
  return output;
}
}  // namespace livekit_ffi
