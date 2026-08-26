# AI Video Generator 🎬

A fully automated AI video generation tool that produces YouTube Shorts/TikToks using free AI services. It generates a script, creates AI voices, fetches or generates AI images, adds subtitles, and even automatically uploads to YouTube.

**100% Free** - No paid APIs required! Uses local Whisper for subtitles, `g4f` for AI models, and Google's YouTube Data API for uploads.

## Features ✨
- 📝 **AI Script Generation**: Automatically writes engaging stories or facts.
- 🗣️ **AI Voiceover**: Uses `edge-tts` for high-quality, natural-sounding voiceovers.
- 🎨 **AI Image Generation**: Utilizes free providers (Pollinations, AI Horde, Pixazo, etc.) and `g4f` for visual assets.
- 💬 **Auto Subtitles**: Generates and burns subtitles into the video using `whisper.cpp` and `ffmpeg`.
- 🚀 **Auto YouTube Upload**: Automatically uploads the generated video to YouTube using the YouTube Data API.

## Prerequisites 🛠️

Ensure you have the following installed on your system:
- **Python 3.8+**
- **FFmpeg**: Required for audio/video processing and burning subtitles.
- **Whisper CLI (`whisper.cpp`)**: Required for subtitle generation. Ensure you have downloaded a `ggml` model.
- **YouTube API Credentials** (Optional, only for auto-uploading).

## Setup & Installation ⚙️

1. **Clone the repository** (or download the source):
   ```bash
   git clone <your-repo-url>
   cd ai_video_generator
   ```

2. **Install Python dependencies**:
   ```bash
   pip install -r requirements.txt
   ```
   *(Note: You can manually install: `moviepy`, `g4f`, `edge_tts`, `requests`, `Pillow`, `numpy`, `tqdm`, `google-api-python-client`, `oauth2client`)*

3. **Set up Whisper (for subtitles)**:
   - Ensure the `gen_subtitle_hindi.sh` script points to your `whisper-cli` binary and `ggml` model correctly.
   - Edit `gen_subtitle_hindi.sh` and update `MODEL` and `WHISPER` paths to match your system.

4. **Set up YouTube Uploading (Optional)**:
   - Go to the [Google Cloud Console](https://console.cloud.google.com/).
   - Create a project and enable the **YouTube Data API v3**.
   - Create OAuth 2.0 Client IDs (Desktop application) and download the JSON file.
   - Rename the downloaded file to `client_secrets.json` and place it in the project root folder.

5. **Set Environment Variables (Optional)**:
   Although the project uses free services, you can configure fallback APIs via environment variables:
   - `OPENROUTER_API_KEY`
   - `PIXAZO_API_KEY`
   - `AI_HORDE_API_KEY`

   You can set these in a `.env` file or export them directly in your terminal.

## Usage 🚀

Run the main script to generate a video:
```bash
python ai_gen.py
```
- The script will generate the script, voice, images, and compile them into a video.
- Subtitles will be burned into the final output.
- *Optional:* If you want to manually upload the video using the CLI, you can use:
  ```bash
  python upload_video.py --file=final_video.mp4 --title="Your Title" --description="Description" --category=22 --privacyStatus="public"
  ```

## Customization 🎨

- **Subtitles**: You can edit `gen_subtitle_hindi.sh` to change the language or modify `ai_gen.py` to change the subtitle style (colors, font size, position).
  - **Changing Subtitle Language**: By default, `gen_subtitle_hindi.sh` is hardcoded to Hindi (`-l hi`). To change it to English, edit the script and change `-l hi` to `-l en`. For automatic language detection, remove the `-l` flag entirely or change it to `-l auto`.
- **Video Style**: Modify `ai_gen.py` to tweak the prompts for the AI image generator to get different visual styles (e.g., anime, cinematic, cartoon).

## Contributing 🤝

Contributions are welcome! Please open an issue or submit a pull request for any improvements or bug fixes.

## License 📜

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
