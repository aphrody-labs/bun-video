# Bun Crunchyroll shortcut extension

This Manifest V3 extension opens the authorized official episode in the current Chrome session. It requests no permissions, host permissions, content scripts or background worker. Credentials remain with Crunchyroll and Chrome. The generated CR monogram is an original shortcut icon, not a downloaded Crunchyroll logo.

After validation, open `chrome://extensions`, enable Developer mode and choose **Load unpacked** → the `assets/crunchyroll-extension` directory inside the installed `@aphrody/bun-video` package. Installing the extension in your real browser has not been performed automatically. Open its popup and select one of the eleven interface languages. This changes the extension UI; the destination remains the supplied official French watch page. Audio/subtitle/account choices remain on Crunchyroll.

All scripts, catalogs and icons are local. No server, package installation, external script, secret or telemetry is needed for the extension popup. Loading the popup does not prove official video playback or Bun media decoding.
