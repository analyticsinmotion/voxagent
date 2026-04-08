# voxagent

Voice-powered terminal agent. Fully offline.

Press a key, speak, get an answer. Nothing leaves your machine.

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

```bash
npm install -g voxagent
voxagent
```

## Requirements

- Node.js 18+
- [Ollama](https://ollama.com) running locally

That's it. No API keys. No cloud accounts. No recurring costs.

On first run, voxagent downloads a small whisper model (~150 MB) for speech-to-text. Everything runs on your machine.

## Usage

```
$ voxagent

Press ENTER to speak...
[Recording...] Press ENTER to stop.

Transcribing...
You: What's the default port for PostgreSQL?

Thinking...
PostgreSQL runs on port 5432 by default.

Press ENTER to speak...
```

### Options

```
--model <name>   Ollama model to use (default: llama3.2)
--help, -h       Show help
--version, -v    Show version
```

## How it works

voxagent captures your voice with [decibri](https://decibri.com), transcribes it locally with [whisper.cpp](https://github.com/ggerganov/whisper.cpp), sends the text to your local [Ollama](https://ollama.com) model, and prints the response.

No audio is recorded, stored, or transmitted. Ever.

## Powered by

- [decibri](https://decibri.com) - cross-platform microphone capture
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) - local speech-to-text
- [Ollama](https://ollama.com) - local LLM inference

## License

Apache 2.0
