# Live Studio

Your own live production and streaming program for Windows.

- **Cameras:** captures directly from Blackmagic capture cards (DeckLink, Intensity, UltraStudio).
- **Shots:** create shots with pan and zoom framing, picture-in-picture, and smooth on-air moves.
- **Graphics and picture:** labels (lower thirds, titles, corner tags), plus exposure and color correction per camera.
- **Speaker captions:** one-click name captions for whoever is speaking.
- **Before service and ending:** a before-service video that plays once or loops, then fades into the camera, plus a closing video.
- **Shortcuts:** set your own key for every action.
- **Audio:** a mixer for your SSL audio interface, camera audio and video files.
- **Output:** streams to YouTube and records to MP4 at the same time.
- **Updates:** installs from a normal `Setup.exe` and updates itself.

---

## 1. Get the installer (one time, about 15 minutes)

The installer is built for free on GitHub's Windows computers. You need a free GitHub account.

1. Sign in at github.com, click **New repository**, name it `live-studio`, and choose **Public**.
   Public lets installed copies download updates without a password. Your stream key is never in the code.
2. Put this project into the repository. The easiest ways:
   - Ask Claude to push it for you after you connect GitHub.
   - Or use **GitHub Desktop**: *File → Add local repository*, choose this folder, then *Publish*.
     Make sure the hidden `.github` folder is included, because it holds the build recipe.
3. On GitHub, open the **Actions** tab and enable workflows if asked.
4. Click **Build Windows installer**, then **Run workflow**, type `1.0.0`, and click **Run**.
5. After about 10 minutes, open **Releases** on the right side of the repository page and download `Live-Studio-Setup-1.0.0.exe`.

### Alternative: build it on the streaming PC itself
Double-click **`build-installer.bat`**. It asks you to install Node.js once if it isn't there yet. After about 5 minutes, `dist\Live-Studio-Setup-x.y.z.exe` appears.
Installers built this way work fine. Automatic updates still come from the GitHub releases described above.

## 2. Prepare the streaming computer

1. Install **Blackmagic Desktop Video** (free, from blackmagicdesign.com → Support).
   In *Blackmagic Desktop Video Setup*, set each input to your camera's format (for example 1080p30) or turn on automatic format detection.
2. Install the **SSL USB audio driver** for Windows from SSL's website (Support → SSL 2 / SSL 2+ / SSL 12).
3. Run `Live-Studio-Setup.exe`. The installer isn't code-signed yet, so Windows may show "Windows protected your PC". Click **More info → Run anyway**.

## 3. First start

- Live Studio finds your Blackmagic inputs and creates a camera for each, with a *wide* and a *close* shot.
- If an SSL interface is connected, it adds **Mic 1** and **Mic 2**.
- Open **⚙ Settings → YouTube** and paste your stream key. In YouTube Studio it's under *Create → Go live → Stream*.
- Pick an encoder in Settings. Use *NVIDIA*, *Intel* or *AMD* if your PC has one, since it leaves the processor free.

## Service flow

- **Holding screen:** a clock (or a countdown to a start time or to your YouTube event) shows from the moment Live Studio opens, so you can go live early.
- **START SERVICE** (`Ctrl+S`): goes live if you aren't yet, starts recording, plays your opening video, then fades to your camera.
- **END SERVICE** (`Ctrl+E`): plays your closing video, goes back to the holding screen (or black), stops recording, and ends the stream after a delay you choose. You can cancel that with *Keep streaming*.
- **⚙ Edit** in the Service panel chooses the videos, fade lengths, camera and each of these steps.

## YouTube connection

Click **Connect…** in the Service panel. The window walks through a one-time Google setup (about 10 minutes: a free Google Cloud project with the YouTube Data API and a *Desktop app* sign-in key). After that, Live Studio:
- lists your upcoming scheduled events and fills in the stream key when you pick one,
- shows whether YouTube is receiving your stream (good / OK / poor) and the viewer count,
- starts the event on YouTube after START SERVICE and ends it after END SERVICE.

## Pictures: logo and seasonal decorations

In **Titles & Graphics**, click **+ Picture**, then **Import picture…** (a PNG with a transparent background works best). Choose a corner, centre or full screen (for a frame or border), plus size, distance from the edge, opacity and fade. Click the 🖼 tile to show or hide it. It stays on through shot changes and is still on the next time you open Live Studio. You can also tick it per shot in Shot Framing, or give it a key.

## Web page overlays (live translation)

In **Titles & Graphics**, click **+ Web page** and paste the link of your live translation page. Live Studio loads the page in the background and puts it over the video, like a browser source.
- Choose where it sits: bottom third, top, full screen, a side, or custom.
- **See-through page background** makes the page's own background invisible. **Remove a colour** keys out a solid background, such as black or green.
- Set the text size, opacity, fade speed and updates per second. Under *Advanced* you can add custom CSS to restyle the page.
- **On air:** click the 🌐 tile (or give it a key in Keyboard shortcuts). It then stays on screen through every shot change until you turn it off.
- **Per shot:** in Shot Framing, tick the page under *Web pages on this shot* so it appears automatically whenever that shot is live.
- The page's own sound is muted.

## Audio

- The master section shows peak and RMS levels with peak hold and clip lights, plus a **phase (mono check)** meter and stereo picture, and loudness in LUFS (YouTube aims for about −14).
- **MONO** lets you listen in mono on your headphones only.
- **⏱ Sync test** measures how far the capture card's sound and picture are apart: clap in front of the camera, and it sets the audio delay to fix it.

## 4. Running a show

| Do this | How |
|---|---|
| Put a shot in Preview (next) | Click it, or press `1`–`9` |
| Send Preview to air | **TAKE** (fade) or `Space`; **CUT** or `Enter` |
| Send a shot straight to air | Double-click it, or `Shift`+`1`–`9` |
| Move or zoom the frame | **Shot Framing** panel: drag the picture, scroll to zoom, or click a point to centre it. Changes to the live shot move smoothly on air. |
| Two screens | **▶ Run Show** has what you use during the service (video, audio, shots, speaker names, labels, videos). **🛠 Setup** has cameras, shot framing and color. |
| Design how labels look | **🎨 Design look…** on any label or in Speaker Names: font, size, colors, box, corners, position on screen, animation and fade speed, with a live preview. |
| Show or hide a label | **SHOW** button, or `F1`–`F8` |
| Caption the person speaking | **People** panel: double-click a name to show it, double-click again to hide it. Clicking another name swaps the caption. Keys `Alt`+`1`–`9`. Add people with the Name / Title row. |
| Before-service video | **Before Service** panel: **Import video…**, then choose *Play once* or *Loop until I start the service*. Pick which camera it fades into and how long the fade is. Press **▶ PLAY** (`I`). When looping, press **START SERVICE** (`S`) to fade into the camera. |
| Play the ending | **▶ PLAY ENDING**. It can fade to black and end the stream automatically. |
| Fade to black | **FADE TO BLACK** or `B` |
| Go live | **GO LIVE**. To end, click **END STREAM** twice. |
| Record | **● REC**. Files go to *Videos\Live Studio* as MP4. |
| Fix camera color | **Color & Exposure** panel. Zebra stripes on Preview show areas that are too bright. |
| Fix lip sync | Audio mixer → ⚙ on the mic → *Audio delay* (try 80–200 ms) |
| Set your own keys | Settings → **Edit keyboard shortcuts…** (or **⌨ Shortcuts…** under the switch buttons). Click *Change* and press any key or combination. Works with USB keypads and Stream Deck. |
| Video won't play (for example ProRes .mov) | Click **Convert to MP4** next to the file. |
| Arrange the screen | **▦ Layout**: drag panels, resize them, hide them, change text size and color. Presets are included. |
| Save a setup for another event | Settings → *Save show as…* / *Open show…* |

## 5. How updates work

1. Ask Claude for a change. The code is updated and pushed to your GitHub repository.
2. On GitHub, go to **Actions → Build Windows installer → Run workflow** and enter a higher version number, such as `1.0.1`.
3. Every installed copy downloads the update in the background. A bar says **"Update ready — Restart & update"**. The app never restarts while you're live; otherwise the update installs the next time you close it.

---

## For developers

```
main.js        desktop app: window, files, settings, encoder, auto-update
preload.js     safe bridge between the interface and the desktop app
streamer.js    FFmpeg encoder control (YouTube RTMPS stream + MP4 recording)
renderer/
  index.html   interface shell
  styles.css   look and layout
  app.js       panels, switching, shots, labels, intro/ending, outputs
  engine.js    GPU video compositor (framing, color, transitions, labels)
  audio.js     audio mixer (inputs, voice processing, limiter, meters)
  bridge.js    browser stand-in so the interface can be designed in Chrome
.github/workflows/build.yml   builds Setup.exe on GitHub and publishes updates
```

To run from source on Windows (needs Node.js 22): `npm install`, then put `ffmpeg.exe` in `resources/ffmpeg/` (or on PATH), then `npm start`.

How the video flows: the cameras feed the GPU compositor, which adds framing, color, labels and transitions. That result is encoded by the bundled FFmpeg: H.264 CBR with a keyframe every 2 seconds plus AAC audio, sent over RTMPS to YouTube and also written to MP4.
