# voxagent

voxagent is a voice agent for the terminal. It records a spoken question with decibri, transcribes it on your machine with whisper.cpp, and prints the answer from a local model in Ollama.

Your audio and your questions never leave your machine.

<!-- badges: start -->
<table>
  <tr>
    <td><strong>Meta</strong></td>
    <td>
      <a href="https://www.npmjs.com/package/voxagent"><img src="https://img.shields.io/npm/v/voxagent" alt="npm version"></a>&nbsp;
      <a href="https://github.com/analyticsinmotion/voxagent/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0 License"></a>&nbsp;
      <a href="https://voxagent.run"><img src="https://img.shields.io/badge/Website-voxagent.run-blue" alt="voxagent.run"></a>&nbsp;
      <a href="https://github.com/analyticsinmotion"><img src="https://github.com/user-attachments/assets/616c530f-cf2a-4f26-8f6c-7397be513847" alt="Analytics in Motion" width="137" height="20"></a>
    </td>
  </tr>
  <tr>
    <td><strong>Powered by</strong></td>
    <td>
      <a href="https://decibri.com"><img src="https://img.shields.io/badge/decibri-mic%20capture-brightgreen" alt="decibri"></a>&nbsp;
      <a href="https://github.com/ggml-org/whisper.cpp"><img src="https://img.shields.io/badge/whisper.cpp-local%20STT-brightgreen" alt="whisper.cpp"></a>&nbsp;
      <a href="https://ollama.com"><img src="https://img.shields.io/badge/Ollama-local%20LLM-brightgreen" alt="Ollama"></a>
    </td>
  </tr>
</table>
<!-- badges: end -->

## Quick start

Install voxagent, pull the default model into Ollama, and start voxagent. The output below is a run with two questions, ended with Ctrl+C.

```bash
npm install -g voxagent
ollama pull llama3.2
voxagent
```

```text

voxagent v0.2.0 - voice-powered terminal

Checking Ollama connection...
Ollama connected.
Loading llama3.2...
llama3.2 ready.
Checking whisper model...
Loading whisper model...
Whisper model ready.

Press ENTER to speak, or Ctrl+C to quit.
Recording. It stops when you stop speaking, or press ENTER to stop now.
Captured 4.7s of audio (150824 bytes)
Transcribing...

You: What is the capital of Australia?

Thinking...

The capital of Australia is Canberra.

Press ENTER to speak, or Ctrl+C to quit.
Recording. It stops when you stop speaking, or press ENTER to stop now.
Captured 5.1s of audio (163624 bytes)
Transcribing...

You: How many days in a leap year?

Thinking...

There are 366 days in a leap year.

Press ENTER to speak, or Ctrl+C to quit.

```

On its first run, voxagent also downloads the whisper model, as described under Privacy and the network.

## How it works

Press Enter at the prompt and ask your question out loud. The recording stops by itself when you stop speaking.

| When | What happens |
| --- | --- |
| You press Enter at the prompt | Recording starts |
| You stop speaking | Recording stops after 1.5 seconds without speech |
| You press Enter while recording | Recording stops at once |
| No speech is heard in the first 8 seconds | Recording stops, and nothing is transcribed |
| Recording reaches 60 seconds | Recording stops, and what was recorded is transcribed |
| You press Ctrl+C | voxagent exits |

voxagent transcribes speech as English, with the whisper model base.en. The microphone is open only while a recording runs. Each question goes to the model on its own, without the earlier questions or answers.

## Requirements

voxagent runs on the three platforms below, with Node.js and Ollama on the same machine.

| Requirement | Details | How to get it |
| --- | --- | --- |
| Windows x64 | The Microsoft Visual C++ Redistributable | [vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe) |
| macOS on Apple Silicon | macOS 14 or later | |
| Linux x64 | glibc 2.38 or later, such as Ubuntu 24.04 or Debian 13, with the Vulkan loader, the GNU OpenMP runtime and the ALSA library | On Debian and Ubuntu, `sudo apt install libvulkan1 libgomp1 libasound2t64` |
| Node.js | 18.3 or later, except Node.js 19 | [nodejs.org](https://nodejs.org) |
| Ollama | Installed and running | [ollama.com](https://ollama.com) |
| A microphone | Not needed with `--file` | |

Intel Macs, and ARM64 on Windows and Linux, are not supported. On any other platform, voxagent stops at startup and lists the supported ones.

## Options

Every option voxagent accepts, as `voxagent --help` lists them.

| Option | Argument | What it does |
| --- | --- | --- |
| `--model` | `<name>` | Ollama model to use (default: llama3.2) |
| `--device` | `<id-or-name>` | Input device to record from (default: the system default) |
| `--list-devices` | | List the available input devices and exit |
| `--file` | `<path>` | Answer one question recorded in an audio file, then exit |
| `--denoise` | | Reduce background noise before transcription |
| `--debug` | | Save each recording to debug-capture.wav in the current directory |
| `--help`, `-h` | | Show this help message |
| `--version`, `-v` | | Show version number |

`--device` takes an id or a name that `--list-devices` prints, and refuses a name that matches more than one input, listing their ids. `--denoise` applies to the microphone and to `--file`.

## Answering from a file

`--file` answers one question recorded in an audio file, then exits. Without it, voxagent needs an interactive terminal. With it, voxagent needs no microphone and no key presses.

```bash
voxagent --file question.wav
```

```text

voxagent v0.2.0 - voice-powered terminal

Read 2.6s of audio (84000 bytes) from question.wav
Checking Ollama connection...
Ollama connected.
Loading llama3.2...
llama3.2 ready.
Checking whisper model...
Loading whisper model...
Whisper model ready.
Transcribing...

You: What is the capital of Australia?

Thinking...

The capital of Australia is Canberra.
```

| Exit code | Meaning |
| --- | --- |
| 0 | The answer was printed |
| 1 | The file could not be read, held no speech, or could not be answered |
| 2 | The command line was not valid, such as `--file` given with `--device` |

The file can be WAV, AIFF, AIFF-C or FLAC. voxagent reads it before loading any model, and exits 1 at once if it cannot be read or holds no speech.

## Privacy and the network

Speech recognition runs on your machine, and so does the language model when it is a local one. This is where each kind of data goes.

| Data | Where it goes |
| --- | --- |
| Your audio | Held in memory and passed to whisper.cpp in a process voxagent starts on your machine. No audio file is written, except with `--debug` |
| Your question | Sent to the Ollama server at `127.0.0.1:11434`, which answers it with the model you chose. With an Ollama cloud model, Ollama sends the question to its cloud service |
| The whisper model | Downloaded once, about 150 MB, from the `ggerganov/whisper.cpp` repository on Hugging Face at a fixed revision, and checked against its SHA-256. It is stored in `.voxagent/models` in your home directory, and downloaded again only if that file is missing or has the wrong size |
| `--debug` recordings | Each recording is saved to `debug-capture.wav` in the current directory, replacing the previous one. The file stays until you delete it |

Apart from the model download, voxagent connects only to the Ollama server on your machine, and it needs no API key or account.

## Keeping the model loaded

Ollama keeps a model in memory for 5 minutes by default, and `OLLAMA_KEEP_ALIVE`, set when the Ollama server starts, changes that time, as the [Ollama FAQ](https://docs.ollama.com/faq#how-do-i-keep-a-model-loaded-in-memory-or-make-it-unload-immediately) describes.

## Licence

Apache 2.0
