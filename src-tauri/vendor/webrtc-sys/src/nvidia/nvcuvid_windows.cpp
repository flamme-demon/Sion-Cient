// ── Sion (2026-09-13) : liaisons NVDEC pour Windows ─────────────────────────
//
// nvcuvid.dll est une API du PILOTE : NVIDIA ne fournit aucune bibliothèque
// d'import pour elle (contrairement au reste de CUDA, couvert par cuda.lib
// depuis le toolkit). Côté Linux, le crate vendu bricolait des shims ELF
// pour les mêmes symboles — c'est le même problème, résolu autrement.
//
// Sous Windows, on fournit les 13 fonctions réellement appelées par les
// décodeurs du crate comme redirections dynamiques vers le pilote : le
// chargement se fait au premier appel, et une absence de pilote se traduit
// proprement en CUDA_ERROR_NOT_INITIALIZED (les appelants retombent sur le
// décodage logiciel) au lieu d'un échec à l'édition de liens.
//
// À conserver tant que l'upstream ne fournit pas de chemin Windows pour ces
// symboles (voir SION_PATCH.md).
#if defined(_WIN32)

#include <windows.h>

#include "cuviddec.h"
#include "nvcuvid.h"

namespace {

HMODULE NvdecModule() {
  static HMODULE module = LoadLibraryA("nvcuvid.dll");
  return module;
}

template <typename Fn>
Fn NvdecSymbol(const char* name) {
  HMODULE module = NvdecModule();
  return module ? reinterpret_cast<Fn>(GetProcAddress(module, name)) : nullptr;
}

}  // namespace

extern "C" {

CUresult CUDAAPI cuvidGetDecoderCaps(CUVIDDECODECAPS* pdc) {
  using Fn = CUresult(CUDAAPI*)(CUVIDDECODECAPS*);
  static Fn fn = NvdecSymbol<Fn>("cuvidGetDecoderCaps");
  return fn ? fn(pdc) : CUDA_ERROR_NOT_INITIALIZED;
}

CUresult CUDAAPI cuvidCreateDecoder(CUvideodecoder* phDecoder,
                                    CUVIDDECODECREATEINFO* pdci) {
  using Fn = CUresult(CUDAAPI*)(CUvideodecoder*, CUVIDDECODECREATEINFO*);
  static Fn fn = NvdecSymbol<Fn>("cuvidCreateDecoder");
  return fn ? fn(phDecoder, pdci) : CUDA_ERROR_NOT_INITIALIZED;
}

CUresult CUDAAPI cuvidDestroyDecoder(CUvideodecoder hDecoder) {
  using Fn = CUresult(CUDAAPI*)(CUvideodecoder);
  static Fn fn = NvdecSymbol<Fn>("cuvidDestroyDecoder");
  return fn ? fn(hDecoder) : CUDA_ERROR_NOT_INITIALIZED;
}

CUresult CUDAAPI cuvidDecodePicture(CUvideodecoder hDecoder,
                                    CUVIDPICPARAMS* pPicParams) {
  using Fn = CUresult(CUDAAPI*)(CUvideodecoder, CUVIDPICPARAMS*);
  static Fn fn = NvdecSymbol<Fn>("cuvidDecodePicture");
  return fn ? fn(hDecoder, pPicParams) : CUDA_ERROR_NOT_INITIALIZED;
}

CUresult CUDAAPI cuvidGetDecodeStatus(CUvideodecoder hDecoder, int nPicIdx,
                                      CUVIDGETDECODESTATUS* pDecodeStatus) {
  using Fn = CUresult(CUDAAPI*)(CUvideodecoder, int, CUVIDGETDECODESTATUS*);
  static Fn fn = NvdecSymbol<Fn>("cuvidGetDecodeStatus");
  return fn ? fn(hDecoder, nPicIdx, pDecodeStatus) : CUDA_ERROR_NOT_INITIALIZED;
}

CUresult CUDAAPI cuvidReconfigureDecoder(
    CUvideodecoder hDecoder, CUVIDRECONFIGUREDECODERINFO* pDecReconfigParams) {
  using Fn = CUresult(CUDAAPI*)(CUvideodecoder, CUVIDRECONFIGUREDECODERINFO*);
  static Fn fn = NvdecSymbol<Fn>("cuvidReconfigureDecoder");
  return fn ? fn(hDecoder, pDecReconfigParams) : CUDA_ERROR_NOT_INITIALIZED;
}

CUresult CUDAAPI cuvidMapVideoFrame64(CUvideodecoder hDecoder, int nPicIdx,
                                      unsigned long long* pDevPtr,
                                      unsigned int* pPitch,
                                      CUVIDPROCPARAMS* pVPP) {
  using Fn = CUresult(CUDAAPI*)(CUvideodecoder, int, unsigned long long*,
                                unsigned int*, CUVIDPROCPARAMS*);
  static Fn fn = NvdecSymbol<Fn>("cuvidMapVideoFrame64");
  return fn ? fn(hDecoder, nPicIdx, pDevPtr, pPitch, pVPP)
            : CUDA_ERROR_NOT_INITIALIZED;
}

CUresult CUDAAPI cuvidUnmapVideoFrame64(CUvideodecoder hDecoder,
                                        unsigned long long DevPtr) {
  using Fn = CUresult(CUDAAPI*)(CUvideodecoder, unsigned long long);
  static Fn fn = NvdecSymbol<Fn>("cuvidUnmapVideoFrame64");
  return fn ? fn(hDecoder, DevPtr) : CUDA_ERROR_NOT_INITIALIZED;
}

CUresult CUDAAPI cuvidCreateVideoParser(CUvideoparser* pObj,
                                        CUVIDPARSERPARAMS* pParams) {
  using Fn = CUresult(CUDAAPI*)(CUvideoparser*, CUVIDPARSERPARAMS*);
  static Fn fn = NvdecSymbol<Fn>("cuvidCreateVideoParser");
  return fn ? fn(pObj, pParams) : CUDA_ERROR_NOT_INITIALIZED;
}

CUresult CUDAAPI cuvidDestroyVideoParser(CUvideoparser obj) {
  using Fn = CUresult(CUDAAPI*)(CUvideoparser);
  static Fn fn = NvdecSymbol<Fn>("cuvidDestroyVideoParser");
  return fn ? fn(obj) : CUDA_ERROR_NOT_INITIALIZED;
}

CUresult CUDAAPI cuvidParseVideoData(CUvideoparser obj,
                                     CUVIDSOURCEDATAPACKET* pPacket) {
  using Fn = CUresult(CUDAAPI*)(CUvideoparser, CUVIDSOURCEDATAPACKET*);
  static Fn fn = NvdecSymbol<Fn>("cuvidParseVideoData");
  return fn ? fn(obj, pPacket) : CUDA_ERROR_NOT_INITIALIZED;
}

CUresult CUDAAPI cuvidCtxLockCreate(CUvideoctxlock* pLock, CUcontext ctx) {
  using Fn = CUresult(CUDAAPI*)(CUvideoctxlock*, CUcontext);
  static Fn fn = NvdecSymbol<Fn>("cuvidCtxLockCreate");
  return fn ? fn(pLock, ctx) : CUDA_ERROR_NOT_INITIALIZED;
}

CUresult CUDAAPI cuvidCtxLockDestroy(CUvideoctxlock lck) {
  using Fn = CUresult(CUDAAPI*)(CUvideoctxlock);
  static Fn fn = NvdecSymbol<Fn>("cuvidCtxLockDestroy");
  return fn ? fn(lck) : CUDA_ERROR_NOT_INITIALIZED;
}

}  // extern "C"

#endif  // _WIN32
