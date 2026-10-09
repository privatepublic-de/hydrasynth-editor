// Prints how eSpeak NG (US English) says each line of stdin: per line one JSON array of
// [phoneme, start ms, length ms], word gaps as "_", plus the line's total length. Used by
// tools/espeak.ts as a pronunciation and timing reference for the speech patch.
// Build: clang -O2 -I/opt/homebrew/include -L/opt/homebrew/lib -lespeak-ng tools/espeakTimings.c -o local/espeak-timings
#include <espeak-ng/speak_lib.h>
#include <stdio.h>
#include <string.h>

#define MAX 512
static char names[MAX][9];
static int starts[MAX];
static int count;
static int samples;
static int rate;

static int callback(short *wav, int n, espeak_EVENT *events) {
  samples += n;
  for (espeak_EVENT *e = events; e->type != espeakEVENT_LIST_TERMINATED; e++) {
    if (e->type != espeakEVENT_PHONEME || count >= MAX) continue;
    memcpy(names[count], e->id.string, 8);
    names[count][8] = 0;
    starts[count++] = e->audio_position;
  }
  return 0;
}

int main(void) {
  rate = espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, NULL, 1); // bit 0: phoneme events
  if (rate <= 0 || espeak_SetVoiceByName("en-us") != EE_OK) return 1;
  espeak_SetSynthCallback(callback);
  char line[1024];
  while (fgets(line, sizeof line, stdin)) {
    line[strcspn(line, "\n")] = 0;
    count = 0;
    samples = 0;
    espeak_Synth(line, strlen(line) + 1, 0, POS_CHARACTER, 0, espeakCHARS_UTF8, NULL, NULL);
    espeak_Synchronize();
    int total = (int)((long long)samples * 1000 / rate);
    printf("{\"ms\":%d,\"phonemes\":[", total);
    for (int i = 0; i < count; i++) {
      int end = i + 1 < count ? starts[i + 1] : total;
      // Quotes and backslashes can't occur in eSpeak's mnemonics we print, but escape them anyway.
      printf("%s[\"", i ? "," : "");
      for (char *c = names[i]; *c; c++) printf(*c == '"' || *c == '\\' ? "\\%c" : "%c", *c);
      printf("\",%d,%d]", starts[i], end - starts[i]);
    }
    printf("]}\n");
    fflush(stdout);
  }
  espeak_Terminate();
  return 0;
}
