// Lists the codecs and demuxers compiled into a libffmpeg build, through FFmpeg's public API
// (av_codec_iterate, av_demuxer_iterate, av_codec_is_encoder; https://ffmpeg.org/doxygen/).
// Only the first fields of AVCodec / AVInputFormat are read; they lead both structs in the
// public headers. Used by tools/codec-audit.mjs. Output: one JSON object.
#include <dlfcn.h>
#include <stdio.h>

typedef struct { const char *name; const char *long_name; int type; int id; } Codec;
typedef struct { const char *name; } InputFormat;

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: ffmpeg-codecs <libffmpeg>\n"); return 2; }
  void *h = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (!h) { fprintf(stderr, "%s\n", dlerror()); return 1; }
  const Codec *(*codec_iterate)(void **) = dlsym(h, "av_codec_iterate");
  int (*is_encoder)(const Codec *) = dlsym(h, "av_codec_is_encoder");
  const InputFormat *(*demuxer_iterate)(void **) = dlsym(h, "av_demuxer_iterate");
  const char *(*version)(void) = dlsym(h, "av_version_info");
  const char *(*license)(void) = dlsym(h, "avcodec_license");
  if (!codec_iterate || !is_encoder || !demuxer_iterate || !version || !license) { fprintf(stderr, "missing FFmpeg API\n"); return 1; }
  printf("{\"version\":\"%s\",\"license\":\"%s\",\"decoders\":[", version(), license());
  void *it = 0; const Codec *c; int n = 0;
  while ((c = codec_iterate(&it))) if (!is_encoder(c)) printf("%s\"%s\"", n++ ? "," : "", c->name);
  printf("],\"encoders\":[");
  it = 0; n = 0;
  while ((c = codec_iterate(&it))) if (is_encoder(c)) printf("%s\"%s\"", n++ ? "," : "", c->name);
  printf("],\"demuxers\":[");
  it = 0; n = 0; const InputFormat *f;
  while ((f = demuxer_iterate(&it))) printf("%s\"%s\"", n++ ? "," : "", f->name);
  printf("]}\n");
  return 0;
}
