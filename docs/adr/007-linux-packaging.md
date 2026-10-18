# ADR-007: One Linux artifact, the AppImage

**Status:** accepted

## Decision

Linux ships a single AppImage. No deb, no rpm, no flatpak, no snap.

`GitRunner` keeps the ability to run git outside a sandbox — `inFlatpakSandbox()` and
`flatpakCommandLine()` rewrite an invocation to `flatpak-spawn --host --directory=<repo>
--env=… git …` — but nothing sets `FLATPAK_ID` in the artifacts we build, so the path is
inert today. It stays because it is the hard part of any future flatpak, and it is tested.

## Why

A git client is a front end for the user's own git, and that git is defined by host state: hooks
that run `node` or `pre-commit`, `git-credential-libsecret` or `gh` for credentials, an
ssh-agent holding keys, LFS filters, `diff.external` pointing at absolute paths. Every packaging
format that isolates the app has to punch a hole back out to all of it.

- **flatpak** was the near miss. Making it work needs the `flatpak-spawn` bridge above *and* a
  fix for askpass: `AskpassServer` points `GIT_ASKPASS` at a script in `TMPDIR`, which the
  flatpak wrapper sets to `$XDG_RUNTIME_DIR/app/$FLATPAK_ID` — visible to the host, so the script
  and its socket are reachable — but the script execs our own binary, which lives at `/app`
  inside the sandbox and nowhere outside it. The manifest also needed `--filesystem=host` and
  `--talk-name=org.freedesktop.Flatpak`, which together are close to full host access: the
  sandbox would have been a formality, not a boundary. That is work and risk for no isolation.
- **deb** built nowhere but CI. electron-builder drives it through fpm, whose bundled Ruby wants
  `libcrypt.so.1`; distributions that moved to libxcrypt (Arch, where this is developed) cannot
  run it at all, so the one artifact nobody could test locally was the one shipping to users.
- **AppImage** needs none of that. It is one file, it runs the host's git directly, and it is the
  only Linux format electron-updater can update in place (`updater.ts` checks GitHub releases ten
  seconds after launch). The costs are real but small: users `chmod +x`, there is no menu entry
  without AppImageLauncher, and older AppImages want `libfuse2` on Ubuntu 22.04 and later.

## Consequences

- Flathub presence is off the table until someone finishes the askpass bridge and settles the
  app id. `appId` is `dev.gitsquid.app`, which claims the domain `gitsquid.dev`; Flathub requires
  an id matching a domain you control, so submitting means owning it or renaming to
  `io.github.JesseWilliamson.GitSquid`, and a rename moves where the app keeps its settings.
- Users on Debian or Fedora who expect a native package get the AppImage instead. Distribution
  packaging, if it ever happens, is better done by those distributions than by this repository.
