# aDrop

This is the React/Electron rebuild of aDrop, created by Abrar Altaay. It keeps the same purpose and safety model as the Python/Tkinter V1, but moves the interface to a modern HTML/CSS frontend.

The app only reads source files and copies `.ARW` files to destinations you choose. It never deletes, moves, renames, or modifies files on the SD card/source.

## Current V1 Rebuild Features

- Source/SD card picker with `/Volumes/*/DCIM` preselection.
- Hard drive destination picker plus saved custom destinations.
- Recursive `.ARW` scan.
- ARW/TIFF EXIF timestamp reading, then `mdls`, then filesystem modified time fallback.
- Date and time-gap batch detection.
- Editable batch folder names.
- Include/exclude whole batches.
- Representative previews using macOS Quick Look.
- Manual split at representative photos.
- Merge with previous batch.
- Editable subfolder preset, defaulting to `RAW, EDITED`.
- Optional copied RAW renaming using batch folder name.
- Parallel copy with a 6-worker limit for balanced speed and older Mac reliability.
- Safe cancel during copy; in-progress file copies finish verification before stopping new work.
- Existing same-size files are skipped.
- Existing different-size conflicts get unique filenames.
- Destination file size verification.
- No `Import_Log.txt` is created in copied shoot folders.
- Live copy count, elapsed time, current speed, and average speed.
- Three-step workflow: scan setup, shoot review, then destination/copy setup.

## Run

```bash
./run_app.sh
```

The first run installs Node dependencies.

## Free One-Line Install

After this folder is pushed as the root of a GitHub repo named `aDrop`, users can install and build aDrop locally with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/AbrarAltaay/aDrop/main/install.sh | bash
```

The installer:

- Clones the repo into `~/.adrop/source`.
- Runs `npm ci`.
- Builds an unsigned local `aDrop.app`.
- Applies a free local ad-hoc signature with `codesign`.
- Copies it to `/Applications/aDrop.app`.

Requirements:

- macOS
- Git
- Node.js and npm

Because this free build is not Apple Developer-signed or notarized, macOS may still block the first launch on some Macs. If that happens, right-click `aDrop` in Applications and choose `Open`.

## Publishing To GitHub

Create a new GitHub repo, then push this folder as the repo root:

```bash
cd /path/to/abrar-photo-importer-electron
git init
git add .
git commit -m "Initial aDrop release"
git branch -M main
git remote add origin https://github.com/AbrarAltaay/aDrop.git
git push -u origin main
```

After that, the one-line installer above will work.

To install from a different GitHub repo URL:

```bash
ADROP_REPO_URL=https://github.com/YOUR_USERNAME/YOUR_REPO.git bash -c "$(curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/install.sh)"
```

## Build macOS App

```bash
./build_app.sh
```

The built unsigned `.app` is written under:

```text
release/
```

To copy a locally built app into Applications from the repo folder:

```bash
./install.sh
```

## Notes

This project intentionally keeps all filesystem work in Electron's main process. The React renderer only displays state and sends user decisions through a safe preload API.

## V2 TODOs

- Saved folder presets.
- Custom file renaming pattern editor.
- Hash-based duplicate detection.
- Lightroom catalog folder automation.
- Smart Preview / VA package export.
- More file types such as JPG, MP4, and XMP.
