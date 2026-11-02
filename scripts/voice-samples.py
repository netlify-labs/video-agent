# Makes the voice preview samples in ui/src/assets/voices (one short line per Kokoro voice the UI offers).
#   python3 -m venv .venv && .venv/bin/pip install kokoro-onnx soundfile
#   npx hyperframes tts "warm up" -o /tmp/w.wav   # downloads the model into ~/.cache/hyperframes/tts
#   .venv/bin/python scripts/voice-samples.py /tmp/voices
#   then for each WAV: ffmpeg -i x.wav -af loudnorm=I=-16:TP=-1.5:LRA=11 -ac 1 -ar 24000 -b:a 48k <voice>.mp3
# On macOS the espeak-ng bundled with the wheel looks for its data at its build machine's path; install espeak-ng
# with Homebrew and point ESPEAK_LIB / ESPEAK_DATA at it (the defaults below). Linux needs neither.
import os, sys
import soundfile as sf
from kokoro_onnx import EspeakConfig, Kokoro
from phonemizer.backend.espeak.wrapper import EspeakWrapper

LIB = os.environ.get('ESPEAK_LIB', '/opt/homebrew/opt/espeak-ng/lib/libespeak-ng.dylib')
DATA = os.environ.get('ESPEAK_DATA', '/opt/homebrew/opt/espeak-ng/share/espeak-ng-data')
CACHE = os.path.expanduser('~/.cache/hyperframes/tts')
VOICES = {'af_heart': 'Heart', 'af_nova': 'Nova', 'af_sky': 'Sky', 'am_adam': 'Adam', 'am_michael': 'Michael',
          'bf_emma': 'Emma', 'bf_isabella': 'Isabella', 'bm_george': 'George'}

espeak = None
if os.path.exists(LIB):
    EspeakWrapper.set_library(LIB)
    EspeakWrapper.set_data_path(DATA)
    espeak = EspeakConfig(lib_path=LIB, data_path=DATA)
k = Kokoro(f'{CACHE}/models/kokoro-v1.0.onnx', f'{CACHE}/voices/voices-v1.0.bin', espeak_config=espeak)
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
for voice, name in VOICES.items():
    text = f"Hi, I'm {name}. Here's how your next launch video could sound."
    audio, rate = k.create(text, voice=voice, speed=1.0, lang='en-gb' if voice.startswith('b') else 'en-us')
    sf.write(f'{out}/{voice}.wav', audio, rate)
    print(voice, round(len(audio) / rate, 2), 's')
