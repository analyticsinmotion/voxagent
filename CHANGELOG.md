# Changelog

All notable changes to voxagent are recorded in this file.

## 0.2.0 - 2026-09-24

### Added

- `--file <path>` answers one question recorded in a WAV, AIFF, AIFF-C or FLAC file, then exits.
- `--list-devices` lists the input devices, and `--device <id-or-name>` records from one of them.
- `--denoise` reduces background noise before transcription.
- A recording stops by itself 1.5 seconds after speech ends, after 8 seconds with no speech, or at 60 seconds.
- Before the first prompt, voxagent checks that the Ollama model is installed, names the `ollama pull` command when it is not, and loads the model.
- The whisper model is downloaded from a fixed revision and checked against its size and SHA-256 before it is used. A file of the wrong size is downloaded again.
- A missing system library is named with how to install it: the Microsoft Visual C++ Redistributable on Windows, and the ALSA library, the Vulkan loader and the GNU OpenMP runtime on Linux.
- An unsupported platform stops voxagent at startup, with the supported platforms listed.
- Microphone errors are reported with instructions.
- Transcription on Linux x64 and on macOS on Apple Silicon.

### Changed

- Audio is held in memory and passed to whisper. No audio file is written unless `--debug` is given.
- Transcription runs in a separate process that keeps the whisper model loaded. Output from whisper itself is shown only with `--debug` or when transcription fails.
- The whisper model is loaded before the first prompt.
- A recording in which no speech is detected is not transcribed.
- Unknown options, options without a value and positional arguments are rejected with exit code 2.
- `--help` lists every option, and `--debug` prints the path of the recording it saves.
- `--help` and `--version` run without loading the native modules.
- The prompt reads `Press ENTER to speak, or Ctrl+C to quit.`
- Without `--file`, voxagent needs an interactive terminal, and exits 1 with a message when its input is redirected or piped.
- Microphone capture uses decibri 5.7.0, which needs the Microsoft Visual C++ Redistributable on Windows.

### Fixed

- The microphone is released and the terminal restored on Ctrl+C and on every other exit.
- The end of each recording is kept in full.
- A failed model download leaves no partial file behind.
- The package contains only `bin/`, `lib/`, the README, the licence and the attribution notice.

### Removed

- Support for Node.js 18.0 to 18.2 and for Node.js 19.
- The `main` entry in `package.json`.

## 0.1.0 - 2026-04-04

### Added

- voxagent records a spoken question from the default microphone, transcribes it with whisper.cpp, sends the text to Ollama and prints the answer.
- ENTER starts a recording and ENTER stops it.
- The whisper model base.en is downloaded on the first run to `.voxagent/models` in the home directory.
- `--model <name>` chooses the Ollama model. The default is `llama3.2`.
- `--debug` saves each recording to `debug-capture.wav` in the current directory and prints the audio levels and the result from whisper.
- `--help` and `--version`.
